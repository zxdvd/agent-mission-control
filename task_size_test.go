package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestOversizedReportHTTPIsDefinitiveRejectionAndOriginalTaskRemainsReadable(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	before, err := x.Store.Apply(x.Task.ID, "reports", store.Input{RunID: x.Task.RunID, Kind: "ready", Message: "Existing result", Origin: "fixture", Evidence: []store.Evidence{{Excerpt: "Keep this existing evidence"}}})
	if err != nil {
		t.Fatal(err)
	}
	message := strings.Repeat("x", 600000)
	input, _ := json.Marshal(store.Input{RunID: x.Task.RunID, Kind: "progress", Message: message, Origin: "fixture"})
	if len(input) >= 1<<20 {
		t.Fatal("fixture must fit HTTP JSON input limit")
	}
	var output bytes.Buffer
	err = report([]string{"-addr", strings.TrimPrefix(x.Server.URL, "http://"), "-task", x.Task.ID, "-run", x.Task.RunID, "-kind", "progress", "-message", message, "-origin", "fixture"}, &output)
	if err == nil || !strings.Contains(err.Error(), "report rejected (400)") || !strings.Contains(err.Error(), "change not saved") || strings.Contains(err.Error(), "delivery unconfirmed") || output.Len() != 0 {
		t.Fatal("oversized JSON request did not receive a definitive small rejection", err)
	}
	saved, err := x.Store.Get(x.Task.ID)
	if err != nil || !reflect.DeepEqual(before, saved) {
		t.Fatal("HTTP rejection changed prior report/evidence/events", err)
	}
	response, err := http.Get(x.Server.URL + "/api/tasks/" + x.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil || response.StatusCode != 200 || len(data) > 1<<20 || !json.Valid(data) {
		t.Fatal("original task is no longer readable", err)
	}
	var reloaded store.Task
	if json.Unmarshal(data, &reloaded) != nil || !reflect.DeepEqual(before, reloaded) {
		t.Fatal("GET after rejection differs from original task")
	}
}
