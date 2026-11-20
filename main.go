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

func handler(s *store.Store) http.Handler { return handlerWithManaged(s, nil) }

func handlerWithManaged(s *store.Store, worker *managedWorker) http.Handler {
	m := http.NewServeMux()
	registerLocalVisibility(m, s)
	registerFollowUps(m, s)
	registerManaged(m, s, worker)
	registerTaskComposer(m, s)
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
		var in struct {
			store.CreateInput
			Image *managedImageInput `json:"image"`
		}
		// Preserve the existing API for non-browser text consumers; screenshots
		// carry more sensitive content and are a local-browser-only flow.
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, managedBodyLimit))
		dec.DisallowUnknownFields()
		var trailing any
		if err := dec.Decode(&in); err != nil || dec.Decode(&trailing) != io.EOF {
			w.WriteHeader(400)
			write(w, map[string]string{"error": "invalid JSON"})
			return
		}
		if in.Image != nil && !managedBrowser(r) {
			writeMutationError(w, "same-origin local browser required for screenshot", http.StatusForbidden)
			return
		}
		img, err := validatedManagedImage(in.Image)
		if err != nil {
			writeMutationError(w, err.Error(), http.StatusBadRequest)
			return
		}
		t, err := s.CreateWithManagedImage(in.CreateInput, img)
		if err != nil {
			code, message := safeMutationError(err)
			w.WriteHeader(code)
			write(w, map[string]string{"error": message})
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
			writeMutationError(w, "requires only run_id, failed_event_id and confirm_stopped:true; verify the old local and external processes have stopped", 400)
			return
		}
		task, err := s.NewAttempt(r.PathValue("id"), in)
		if err != nil {
			code, message := safeMutationError(err)
			writeMutationError(w, message, code)
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
			writeMutationError(w, "project_name must be an explicit string; use empty string to clear", 400)
			return
		}
		task, err := s.SetProjectName(r.PathValue("id"), *in.ProjectName)
		if err != nil {
			code, message := safeMutationError(err)
			writeMutationError(w, message, code)
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
			writeMutationError(w, "invalid JSON", 400)
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
			writeMutationError(w, "local follow-up requires the unchanged current viewed report; refresh before acting", code)
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
			writeMutationError(w, "invalid JSON", 400)
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
			writeMutationError(w, "current delivery changed or is not reviewable; refresh before marking seen", code)
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
			code, message := safeMutationError(e)
			w.WriteHeader(code)
			write(w, map[string]string{"error": message})
			return
		}
		write(w, t)
	})
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { http.NotFound(w, r) })
	sub, _ := fs.Sub(assets, "web/dist")
	static := http.FileServer(http.FS(sub))
	m.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		w.Header().Set("X-Frame-Options", "DENY")
		static.ServeHTTP(w, r)
	}))
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
	if len(os.Args) > 1 && os.Args[1] == "follow-up-worker" {
		if e := followUpWorker(os.Args[2:], os.Stdout); e != nil {
			log.Fatal(e)
		}
		return
	}
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
	managedHome := flag.String("managed-codex-home", "", "dedicated canonical Codex home for explicit card actions")
	managedCwd := flag.String("managed-cwd", "", "dedicated canonical working directory for explicit card actions")
	managedNoSandbox := flag.Bool("managed-no-sandbox", false, "explicitly allow managed text tasks without a Codex shell sandbox; local foreground operator unlock required")
	ackManaged := flag.Bool("ack-vetted-runner", false, "operator confirms managed Codex home, project rules, extensions and connectors are suited to this scope")
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
	var worker *managedWorker
	if *managedHome != "" || *managedCwd != "" || *ackManaged || *managedNoSandbox {
		if *demo {
			log.Fatal("managed Codex cannot be enabled with demo data")
		}
		worker, e = newManagedWorker(*managedHome, *managedCwd, *ackManaged, *managedNoSandbox)
		if e != nil {
			log.Fatal(e)
		}
	}
	listener, e := net.Listen("tcp", *addr)
	if e != nil {
		log.Fatal(e)
	}
	defer listener.Close()
	fmt.Printf("Local work records: http://%s (managed Agent only after explicit action: %t; synthetic seed: %t)\n", strings.TrimSpace(*addr), worker != nil, *demo)
	if worker != nil && worker.noSandbox {
		fmt.Printf("Managed Codex: no shell sandbox. Working directory: %q. Files outside it are not sandbox-protected.\n", worker.cwd)
		tty, err := os.OpenFile("/dev/tty", os.O_WRONLY, 0)
		if err != nil {
			log.Fatal("managed no-sandbox mode requires a private controlling terminal; server not started")
		}
		_, err = fmt.Fprintf(tty, "Private Workbench browser unlock code (this launch only): %s\n", worker.runCode)
		_ = tty.Close()
		if err != nil {
			log.Fatal("managed no-sandbox unlock could not be shown in the controlling terminal; server not started")
		}
	}
	log.Fatal(http.Serve(listener, handlerWithManaged(s, worker)))
}
