package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLocalVisibilityHTTPStrictContractAndSafeErrors(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "visibility.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(store.CreateInput{Title: "Local visibility", Goal: "No execution", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	post := func(id, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/tasks/"+id+"/local-visibility", strings.NewReader(body))
		req.Host = "127.0.0.1:8787"
		res := httptest.NewRecorder()
		handler(s).ServeHTTP(res, req)
		return res
	}
	body := `{"run_id":"` + task.RunID + `","operation":"hide","expected_recorded_at":"","last_report_event_id":"","launch_notice_recorded_at":""}`
	for _, bad := range []string{
		`{}`, `null`, strings.Replace(body, `,"launch_notice_recorded_at":""`, "", 1), strings.Replace(body, `"launch_notice_recorded_at":""`, `"launch_notice_recorded_at":null`, 1), body + ` {}`, body + ` true`, strings.Replace(body, `"expected_recorded_at":"",`, "", 1), strings.Replace(body, `"last_report_event_id":""`, `"last_report_event_id":null`, 1), strings.Replace(body, `"operation":"hide"`, `"operation":"hide","operation":"restore"`, 1), strings.Replace(body, `"run_id"`, `"Run_ID"`, 1), strings.Replace(body, `"operation":"hide"`, `"operation":"complete"`, 1), strings.Replace(body, `"last_report_event_id":""`, `"last_report_event_id":"","extra":true`, 1),
	} {
		if res := post(task.ID, bad); res.Code != 400 {
			t.Fatal("malformed accepted", bad, res.Code, res.Body.String())
		}
	}
	unchanged, _ := s.Get(task.ID)
	if !reflect.DeepEqual(unchanged, task) {
		t.Fatal("invalid request mutated task")
	}
	res := post(task.ID, body)
	if res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	var hidden store.Task
	if err = json.NewDecoder(bytes.NewReader(res.Body.Bytes())).Decode(&hidden); err != nil {
		t.Fatal(err)
	}
	if hidden.LocalVisibility == nil || hidden.LocalVisibility.State != "hidden" || hidden.Status != "not_started" {
		t.Fatal(hidden)
	}
	if res = post(task.ID, body); res.Code != 409 {
		t.Fatal("stale revision accepted", res.Code)
	}
	restore, _ := json.Marshal(store.LocalVisibilityInput{RunID: task.RunID, Operation: "restore", ExpectedRecordedAt: hidden.LocalVisibility.RecordedAt, LastReportEventID: ""})
	if res = post(task.ID, string(restore)); res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	if res = post("missing", body); res.Code != 404 || !strings.Contains(res.Body.String(), `"error":"task not found"`) {
		t.Fatal(res.Code, res.Body.String())
	}
	s.Close()
	res = post(task.ID, body)
	if res.Code != 500 || strings.Contains(res.Body.String(), "sql") || strings.Contains(res.Body.String(), "database") || strings.Contains(res.Body.String(), "closed") {
		t.Fatal("raw storage error", res.Code, res.Body.String())
	}
}
