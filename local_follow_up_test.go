package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestLocalFollowUpHTTPExactEndResumeAndNewReport(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	ready, err := x.Store.Apply(x.Task.ID, "reports", store.Input{RunID: x.Task.RunID, Kind: "ready", Message: "Result", Origin: "fixture", Evidence: []store.Evidence{{Excerpt: "Declared evidence"}}})
	if err != nil {
		t.Fatal(err)
	}
	report := store.CurrentReadyReportID(ready)
	post := func(id, op, expected string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"run_id": ready.RunID, "report_event_id": id, "operation": op, "expected_recorded_at": expected})
		req := httptest.NewRequest("POST", "/api/tasks/"+ready.ID+"/local-follow-up", bytes.NewReader(body))
		req.Host = "127.0.0.1:8787"
		res := httptest.NewRecorder()
		handler(x.Store).ServeHTTP(res, req)
		return res
	}
	if res := post(report, "end", ""); res.Code != 409 {
		t.Fatal("unread end allowed", res.Code)
	}
	if _, err = x.Store.ReviewDelivery(ready.ID, ready.RunID, report); err != nil {
		t.Fatal(err)
	}
	if res := post(report, "end", ""); res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	ended, _ := x.Store.Get(ready.ID)
	if ended.Status != "ready" || ended.LocalFollowUp.State != "ended" {
		t.Fatal(ended)
	}
	if res := post(report, "resume", ended.LocalFollowUp.RecordedAt); res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	open, _ := x.Store.Get(ready.ID)
	if open.LocalFollowUp.State != "open" || !reflect.DeepEqual(open.DeliveryReview, ended.DeliveryReview) {
		t.Fatal(open)
	}
	if res := post(report, "end", ""); res.Code != 409 {
		t.Fatal("stale end accepted", res.Code)
	}
	newer, err := x.Store.Apply(ready.ID, "reports", store.Input{RunID: ready.RunID, Kind: "ready", Message: "Updated", Origin: "fixture", Evidence: []store.Evidence{{Excerpt: "New evidence"}}})
	if err != nil {
		t.Fatal(err)
	}
	if res := post(report, "resume", open.LocalFollowUp.RecordedAt); res.Code != 409 {
		t.Fatal("old report accepted", res.Code)
	}
	after, _ := x.Store.Get(ready.ID)
	if !reflect.DeepEqual(newer, after) {
		t.Fatal(after)
	}
}
