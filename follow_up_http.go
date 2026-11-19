package main

import (
	"agentworkbench/internal/store"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
)

type followUpView struct {
	store.FollowUpInput
	TaskID     string `json:"task_id"`
	State      string `json:"state"`
	Reply      string `json:"reply,omitempty"`
	CreatedAt  string `json:"created_at"`
	ClaimedAt  string `json:"claimed_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
}

func followUpReadView(f store.FollowUp) followUpView {
	return followUpView{
		FollowUpInput: store.FollowUpInput{RequestID: f.RequestID, RunID: f.RunID, ReportEventID: f.ReportEventID, Kind: f.Kind, Message: f.Message},
		TaskID:        f.TaskID, State: f.State, Reply: f.Reply, CreatedAt: f.CreatedAt, ClaimedAt: f.ClaimedAt, FinishedAt: f.FinishedAt,
	}
}

func registerFollowUps(m *http.ServeMux, s *store.Store) {
	const path = "/api/tasks/{id}/follow-ups"
	write := func(w http.ResponseWriter, status int, v any) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	writeErr := func(w http.ResponseWriter, err error) {
		if errors.Is(err, store.ErrInvalidFollowUp) {
			message := "请填写不超过 8000 字的指示，选择解释或调整。"
			if err.Error() == "invalid follow-up: follow-up snapshot exceeds 1 MiB; no request or partial snapshot was saved" {
				message = "这份交付的证据超过跟进长度限制，指示未保存。"
			}
			write(w, http.StatusBadRequest, map[string]string{"error": message})
			return
		}
		if errors.Is(err, store.ErrConflict) {
			message := "当前交付已变化，请刷新后再确认。"
			switch err.Error() {
			case "state conflict: this task already has a pending or running follow-up":
				message = "这张卡还有一条跟进待处理，请先查看它。"
			case "state conflict: follow-up history limit of 50 reached; no records were removed":
				message = "当前卡片已保留 50 条跟进，未删除旧记录。"
			case "state conflict: request_id already names a different follow-up payload":
				message = "请求编号已使用。请读取原记录，不要重发不同的指示。"
			}
			write(w, http.StatusConflict, map[string]string{"error": message})
			return
		}
		code, message := safeMutationError(err)
		write(w, code, map[string]string{"error": message})
	}
	local := func(r *http.Request) bool {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		return err == nil && net.ParseIP(host).IsLoopback()
	}
	m.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
		if !local(r) {
			write(w, http.StatusForbidden, map[string]string{"error": "loopback client required"})
			return
		}
		items, err := s.ListFollowUps(r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		views := make([]followUpView, 0, len(items))
		for _, item := range items {
			views = append(views, followUpReadView(item))
		}
		write(w, http.StatusOK, views)
	})
	m.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
		// Only the local browser records intents. No HTTP endpoint claims or
		// executes them; a separately and explicitly configured worker does that.
		if !local(r) || r.Header.Get("Origin") != "http://"+r.Host {
			write(w, http.StatusForbidden, map[string]string{"error": "same-origin local browser required"})
			return
		}
		media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if media != "application/json" {
			write(w, http.StatusUnsupportedMediaType, map[string]string{"error": "application/json required"})
			return
		}
		in, err := decodeFollowUp(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			write(w, http.StatusBadRequest, map[string]string{"error": "invalid follow-up request"})
			return
		}
		item, err := s.SubmitFollowUp(r.PathValue("id"), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		write(w, http.StatusOK, followUpReadView(item))
	})
}

func decodeFollowUp(body io.Reader) (store.FollowUpInput, error) {
	var in store.FollowUpInput
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
		var target *string
		switch name {
		case "request_id":
			target = &in.RequestID
		case "run_id":
			target = &in.RunID
		case "report_event_id":
			target = &in.ReportEventID
		case "kind":
			target = &in.Kind
		case "message":
			target = &in.Message
		default:
			return in, errors.New("unexpected field")
		}
		var value *string
		if err := dec.Decode(&value); err != nil || value == nil {
			return in, errors.New("expected a string")
		}
		*target = *value
	}
	last, err := dec.Token()
	var trailing any
	if err != nil || last != json.Delim('}') || len(seen) != 5 || dec.Decode(&trailing) != io.EOF {
		return in, errors.New("expected one complete follow-up object")
	}
	return in, nil
}
