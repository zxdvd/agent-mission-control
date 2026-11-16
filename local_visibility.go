package main

import (
	"agentworkbench/internal/store"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Require all five exact string fields, including explicit empty report/revision
// values for a new task. Reject duplicate/case-folded names, null and extra JSON.
func decodeLocalVisibility(body io.Reader) (store.LocalVisibilityInput, error) {
	var in store.LocalVisibilityInput
	dec := json.NewDecoder(body)
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return in, errors.New("expected object")
	}
	fields := map[string]*string{"run_id": &in.RunID, "operation": &in.Operation, "expected_recorded_at": &in.ExpectedRecordedAt, "last_report_event_id": &in.LastReportEventID, "launch_notice_recorded_at": &in.LaunchNoticeRecordedAt}
	seen := map[string]bool{}
	for dec.More() {
		token, err = dec.Token()
		if err != nil {
			return in, err
		}
		key, ok := token.(string)
		target := fields[key]
		if !ok || target == nil || seen[key] {
			return in, errors.New("unexpected or duplicate field")
		}
		seen[key] = true
		token, err = dec.Token()
		value, ok := token.(string)
		if err != nil || !ok {
			return in, errors.New("expected explicit string")
		}
		*target = value
	}
	if _, err = dec.Token(); err != nil {
		return in, err
	}
	var extra any
	if len(seen) != len(fields) || dec.Decode(&extra) != io.EOF || in.RunID == "" || (in.Operation != "hide" && in.Operation != "restore") {
		return in, errors.New("explicit run, operation, report and revision required")
	}
	return in, nil
}

func registerLocalVisibility(m *http.ServeMux, s *store.Store) {
	m.HandleFunc("POST /api/tasks/{id}/local-visibility", func(w http.ResponseWriter, r *http.Request) {
		in, err := decodeLocalVisibility(http.MaxBytesReader(w, r.Body, 4096))
		if err != nil {
			writeMutationError(w, "requires only explicit string run_id, operation hide/restore, expected_recorded_at, last_report_event_id and launch_notice_recorded_at", http.StatusBadRequest)
			return
		}
		task, err := s.SetLocalVisibility(r.PathValue("id"), in)
		if err != nil {
			code, message := http.StatusInternalServerError, "local visibility could not be saved; refresh and try again"
			if errors.Is(err, store.ErrConflict) {
				code, message = http.StatusConflict, "local visibility changed or work is no longer local not-started/blocked; refresh before acting"
			}
			if errors.Is(err, sql.ErrNoRows) {
				code, message = http.StatusNotFound, "task not found"
			}
			writeMutationError(w, message, code)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(task)
	})
}
