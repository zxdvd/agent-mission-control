package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestDeliveryReviewHTTPPinsPicturedReportAndReloads(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	ready, err := x.Store.Apply(x.Task.ID, "reports", store.Input{RunID: x.Task.RunID, Kind: "ready", Message: "Declared result", Origin: "fixture", Evidence: []store.Evidence{{Label: "Fixture", Excerpt: "Not independent verification"}}})
	if err != nil {
		t.Fatal(err)
	}
	reportID := store.CurrentReadyReportID(ready)
	post := func(run, id string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"run_id": run, "report_event_id": id})
		req := httptest.NewRequest(http.MethodPost, "/api/tasks/"+ready.ID+"/review-delivery", bytes.NewReader(body))
		req.Host = "127.0.0.1:8787"
		resp := httptest.NewRecorder()
		handler(x.Store).ServeHTTP(resp, req)
		return resp
	}
	for attempt := 0; attempt < 2; attempt++ {
		response := post(ready.RunID, reportID)
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	saved, _ := x.Store.Get(ready.ID)
	if saved.DeliveryReview == nil || saved.Status != "ready" || len(saved.Events) != len(ready.Events) {
		t.Fatal(saved)
	}
	req := httptest.NewRequest("GET", "/api/tasks/"+ready.ID, nil)
	resp := httptest.NewRecorder()
	handler(x.Store).ServeHTTP(resp, req)
	var reload store.Task
	if json.Unmarshal(resp.Body.Bytes(), &reload) != nil || !reflect.DeepEqual(saved, reload) {
		t.Fatal(resp.Body.String())
	}
	newer, err := x.Store.Apply(ready.ID, "reports", store.Input{RunID: ready.RunID, Kind: "ready", Message: "New evidence", Origin: "fixture", Evidence: []store.Evidence{{Excerpt: "New evidence"}}})
	if err != nil {
		t.Fatal(err)
	}
	if response := post(ready.RunID, reportID); response.Code != 409 {
		t.Fatal("stale DOM accepted", response.Code)
	}
	after, _ := x.Store.Get(ready.ID)
	if !reflect.DeepEqual(newer, after) {
		t.Fatal("stale click changed latest result", after)
	}
	// Never accept a generic completion payload or a client-supplied review date.
	bad := httptest.NewRequest("POST", "/api/tasks/"+ready.ID+"/review-delivery", strings.NewReader(`{"run_id":"`+ready.RunID+`","report_event_id":"`+store.CurrentReadyReportID(newer)+`","reviewed_at":"fake"}`))
	bad.Host = "127.0.0.1:8787"
	invalid := httptest.NewRecorder()
	handler(x.Store).ServeHTTP(invalid, bad)
	if invalid.Code != 400 {
		t.Fatal(invalid.Code, invalid.Body.String())
	}
}
