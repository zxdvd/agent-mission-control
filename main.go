package main

import (
	"agentworkbench/internal/herdr"
	"agentworkbench/internal/store"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

//go:embed all:web/dist
var assets embed.FS

// decodeNewAttempt accepts one exact object, including case-sensitive field
// names and no duplicate keys. Attestation is never defaulted from task state.
func decodeNewAttempt(body io.Reader) (store.NewAttemptInput, error) {
	var in store.NewAttemptInput
	dec := json.NewDecoder(body)
	first, err := dec.Token()
	if err != nil || first != json.Delim('{') {
		return in, errors.New("expected object")
	}
	seen := map[string]bool{}
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			return in, err
		}
		name, ok := key.(string)
		if !ok || seen[name] {
			return in, errors.New("invalid or duplicate field")
		}
		seen[name] = true
		switch name {
		case "run_id":
			err = dec.Decode(&in.RunID)
		case "failed_event_id":
			err = dec.Decode(&in.FailedEventID)
		case "confirm_stopped":
			err = dec.Decode(&in.ConfirmStopped)
		default:
			return in, errors.New("unexpected field")
		}
		if err != nil {
			return in, err
		}
	}
	if _, err = dec.Token(); err != nil {
		return in, err
	}
	var trailing any
	if dec.Decode(&trailing) != io.EOF || len(seen) != 3 || !in.ConfirmStopped || strings.TrimSpace(in.RunID) == "" || strings.TrimSpace(in.FailedEventID) == "" {
		return in, errors.New("explicit run, failure and stopped confirmation required")
	}
	return in, nil
}

func handler(s *store.Store) http.Handler {
	m := http.NewServeMux()
	write := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(v)
	}
	m.HandleFunc("GET /api/herdr", func(w http.ResponseWriter, r *http.Request) {
		c, e := herdr.New()
		if e != nil {
			write(w, map[string]any{"available": false, "mode": "read_only", "compatibility": "unverified", "error": e.Error()})
			return
		}
		data, e := c.List(r.Context())
		if e != nil {
			write(w, map[string]any{"available": false, "mode": "read_only", "compatibility": "unverified", "error": e.Error()})
			return
		}
		entries, e := herdr.Observations(data)
		if e != nil {
			write(w, map[string]any{"available": true, "mode": "read_only", "compatibility": "unsupported", "error": e.Error()})
			return
		}
		write(w, map[string]any{"available": true, "mode": "read_only", "compatibility": "verified", "entries": entries, "observed_at": time.Now().UTC().Format(time.RFC3339Nano)})
	})
	m.HandleFunc("GET /api/projects", func(w http.ResponseWriter, r *http.Request) {
		items, e := s.List()
		if e != nil {
			http.Error(w, "database read failed", 500)
			return
		}
		demo := false
		for _, t := range items {
			if t.ProjectID == "demo" {
				demo = true
			}
		}
		projects := []store.Project{}
		for _, p := range store.Projects() {
			if (demo && p.ID == "demo") || (!demo && p.ID == "local") {
				projects = append(projects, p)
			}
		}
		write(w, projects)
	})
	m.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		var in store.CreateInput
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&in); err != nil {
			w.WriteHeader(400)
			write(w, map[string]string{"error": "invalid JSON"})
			return
		}
		t, err := s.Create(in)
		if err != nil {
			w.WriteHeader(400)
			write(w, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusCreated)
		write(w, t)
	})
	m.HandleFunc("GET /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		t, e := s.List()
		if e != nil {
			http.Error(w, "database read failed", 500)
			return
		}
		write(w, t)
	})
	m.HandleFunc("GET /api/tasks/{id}", func(w http.ResponseWriter, r *http.Request) {
		t, e := s.Get(r.PathValue("id"))
		if e != nil {
			http.Error(w, "task not found", 404)
			return
		}
		write(w, t)
	})
	m.HandleFunc("POST /api/tasks/{id}/new-attempt", func(w http.ResponseWriter, r *http.Request) {
		in, decodeErr := decodeNewAttempt(http.MaxBytesReader(w, r.Body, 1024))
		if decodeErr != nil {
			http.Error(w, "requires only run_id, failed_event_id and confirm_stopped:true; verify the old local and external processes have stopped", 400)
			return
		}
		task, err := s.NewAttempt(r.PathValue("id"), in)
		if err != nil {
			code := 400
			if errors.Is(err, store.ErrConflict) {
				code = 409
			}
			if errors.Is(err, sql.ErrNoRows) {
				code = 404
			}
			http.Error(w, err.Error(), code)
			return
		}
		write(w, task)
	})
	m.HandleFunc("POST /api/tasks/{id}/project-name", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ProjectName *string `json:"project_name"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		var trailing any
		if dec.Decode(&in) != nil || in.ProjectName == nil || dec.Decode(&trailing) != io.EOF {
			http.Error(w, "project_name must be an explicit string; use empty string to clear", 400)
			return
		}
		task, err := s.SetProjectName(r.PathValue("id"), *in.ProjectName)
		if err != nil {
			code := 400
			if errors.Is(err, store.ErrConflict) {
				code = 409
			}
			if errors.Is(err, sql.ErrNoRows) {
				code = 404
			}
			http.Error(w, err.Error(), code)
			return
		}
		write(w, task)
	})
	m.HandleFunc("POST /api/tasks/{id}/local-follow-up", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			RunID         string `json:"run_id"`
			ReportEventID string `json:"report_event_id"`
			Operation     string `json:"operation"`
			ExpectedAt    string `json:"expected_recorded_at"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		if dec.Decode(&in) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		task, err := s.SetLocalFollowUp(r.PathValue("id"), in.RunID, in.ReportEventID, in.Operation, in.ExpectedAt)
		if err != nil {
			code := 400
			if errors.Is(err, store.ErrConflict) {
				code = 409
			}
			if errors.Is(err, sql.ErrNoRows) {
				code = 404
			}
			http.Error(w, "local follow-up requires the unchanged current viewed report; refresh before acting", code)
			return
		}
		write(w, task)
	})
	m.HandleFunc("POST /api/tasks/{id}/review-delivery", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			RunID         string `json:"run_id"`
			ReportEventID string `json:"report_event_id"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		if dec.Decode(&in) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		task, err := s.ReviewDelivery(r.PathValue("id"), in.RunID, in.ReportEventID)
		if err != nil {
			code := 400
			if errors.Is(err, store.ErrConflict) {
				code = 409
			}
			if errors.Is(err, sql.ErrNoRows) {
				code = 404
			}
			http.Error(w, "current delivery changed or is not reviewable; refresh before marking seen", code)
			return
		}
		write(w, task)
	})
	m.HandleFunc("POST /api/tasks/{id}/codex-missing", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			RunID string `json:"run_id"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		if dec.Decode(&in) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		notice, err := s.NoteCodexMissing(r.PathValue("id"), in.RunID)
		if err != nil {
			code := 400
			if errors.Is(err, store.ErrConflict) {
				code = 409
			}
			if errors.Is(err, sql.ErrNoRows) {
				code = 404
			}
			http.Error(w, "launch notice rejected", code)
			return
		}
		write(w, notice)
	})
	m.HandleFunc("POST /api/tasks/{id}/codex-observed-start", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			RunID          string `json:"run_id"`
			NativeThreadID string `json:"native_thread_id"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		dec.DisallowUnknownFields()
		if dec.Decode(&in) != nil {
			http.Error(w, "invalid JSON", 400)
			return
		}
		observation, err := s.ObserveCodexStart(r.PathValue("id"), in.RunID, in.NativeThreadID)
		if err != nil {
			code := 400
			if errors.Is(err, store.ErrConflict) {
				code = 409
			}
			if errors.Is(err, sql.ErrNoRows) {
				code = 404
			}
			http.Error(w, "native start observation rejected", code)
			return
		}
		write(w, observation)
	})
	m.HandleFunc("POST /api/tasks/{id}/{action}", func(w http.ResponseWriter, r *http.Request) {
		var in store.Input
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in) != nil {
			w.WriteHeader(400)
			write(w, map[string]string{"error": "invalid JSON"})
			return
		}
		t, e := s.Apply(r.PathValue("id"), r.PathValue("action"), in)
		if e != nil {
			code := 400
			if errors.Is(e, store.ErrConflict) {
				code = 409
			}
			if errors.Is(e, sql.ErrNoRows) {
				code = 404
			}
			w.WriteHeader(code)
			write(w, map[string]string{"error": e.Error()})
			return
		}
		write(w, t)
	})
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	sub, _ := fs.Sub(assets, "web/dist")
	m.Handle("/", http.FileServer(http.FS(sub)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			origin := r.Header.Get("Origin")
			if origin != "" {
				u, e := url.Parse(origin)
				if e != nil || u.Host != r.Host {
					http.Error(w, "cross-origin mutation refused", http.StatusForbidden)
					return
				}
			}
			host, _, e := net.SplitHostPort(r.Host)
			if e != nil {
				host = r.Host
			}
			ip := net.ParseIP(host)
			if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
				http.Error(w, "loopback host required", http.StatusForbidden)
				return
			}
		}
		m.ServeHTTP(w, r)
	})
}
func loopback(addr string) bool {
	host, _, e := net.SplitHostPort(addr)
	if e != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "codex-run" {
		if e := codexRun(os.Args[2:], os.Stdin, os.Stdout); e != nil {
			log.Fatal(e)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "decision" {
		if e := decision(os.Args[2:], os.Stdout); e != nil {
			log.Fatal(e)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "report" {
		if e := report(os.Args[2:], os.Stdout); e != nil {
			log.Fatal(e)
		}
		return
	}
	addr := flag.String("addr", "127.0.0.1:8787", "loopback listen address")
	db := flag.String("db", "workbench.db", "SQLite database file")
	demo := flag.Bool("demo", false, "explicitly seed synthetic demo tasks in this database")
	flag.Parse()
	if !loopback(*addr) {
		log.Fatal("only an explicit loopback IP is supported")
	}
	s, e := store.Open(*db)
	if e != nil {
		log.Fatal(e)
	}
	defer s.Close()
	if *demo {
		if e = s.Seed(); e != nil {
			log.Fatal(e)
		}
	}
	fmt.Printf("Local work records: http://%s (no Agent execution; synthetic seed: %t)\n", strings.TrimSpace(*addr), *demo)
	log.Fatal(http.ListenAndServe(*addr, handler(s)))
}
