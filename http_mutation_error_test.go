package main

import (
	"agentworkbench/internal/store"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestExistingMutationHTTPDoesNotExposeStorageErrors(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "safe-errors.db"))
	if err != nil {
		t.Fatal(err)
	}
	task, err := s.Create(store.CreateInput{Title: "Public fixture", Goal: "Verify safe errors", Origin: "test"})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	for _, tc := range []struct{ path, body string }{
		{"/api/tasks", `{"title":"Task","goal":"Goal","origin":"test"}`},
		{"/api/tasks/" + task.ID + "/project-name", `{"project_name":"Label"}`},
		{"/api/tasks/" + task.ID + "/new-attempt", `{"run_id":"` + task.RunID + `","failed_event_id":"old","confirm_stopped":true}`},
		{"/api/tasks/" + task.ID + "/reports", `{"run_id":"` + task.RunID + `","kind":"progress","message":"Update","origin":"test"}`},
	} {
		req := httptest.NewRequest("POST", tc.path, strings.NewReader(tc.body))
		req.Host = "127.0.0.1:8787"
		res := httptest.NewRecorder()
		handler(s).ServeHTTP(res, req)
		if res.Code != 500 || !strings.Contains(res.Body.String(), "change could not be saved") || strings.Contains(res.Body.String(), "closed") || strings.Contains(res.Body.String(), "sql") {
			t.Fatal(tc.path, res.Code, res.Body.String())
		}
	}
	if code, message := safeMutationError(errors.New("SYNTHETIC_SECRET /private/storage.db")); code != 500 || strings.Contains(message, "SECRET") || strings.Contains(message, "storage") {
		t.Fatal(code, message)
	}
}

func TestKnownMutationErrorsRemainConcreteJSON(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "known-errors.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(store.CreateInput{Title: "Public fixture", Goal: "Verify known errors", Origin: "test"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		action, body, description string
		status                    int
	}{
		{"project-name", `{}`, "project_name must be an explicit string", 400},
		{"project-name", `{"project_name":"` + strings.Repeat("x", 61) + `"}`, "project_name must be valid text of at most 60 characters", 400},
		{"new-attempt", `{}`, "confirm_stopped:true", 400},
		{"local-follow-up", `{}`, "unchanged current viewed report", 400},
		{"local-follow-up", `{`, "invalid JSON", 400},
		{"review-delivery", `{}`, "current delivery changed or is not reviewable", 409},
		{"review-delivery", `{`, "invalid JSON", 400},
		{"new-attempt", `{"run_id":"` + task.RunID + `","failed_event_id":"not-current","confirm_stopped":true}`, "unchanged eligible local failure", 409},
	} {
		req := httptest.NewRequest("POST", "/api/tasks/"+task.ID+"/"+tc.action, strings.NewReader(tc.body))
		req.Host = "127.0.0.1:8787"
		res := httptest.NewRecorder()
		handler(s).ServeHTTP(res, req)
		var payload map[string]string
		if res.Code != tc.status || !strings.HasPrefix(res.Header().Get("Content-Type"), "application/json") || json.Unmarshal(res.Body.Bytes(), &payload) != nil || !strings.Contains(payload["error"], tc.description) {
			t.Fatal(tc.action, res.Code, res.Header(), res.Body.String())
		}
	}
}
