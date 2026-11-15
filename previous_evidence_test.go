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

func TestSequentialReadyHTTPPreservesOnlyPreviousEvidenceAndDecisionReadIsReadOnly(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	post := func(label string, entries []store.Evidence) store.Task {
		body, _ := json.Marshal(store.Input{RunID: x.Task.RunID, Kind: "ready", Message: label, Origin: "Fixture reporter", Evidence: entries})
		response, err := http.Post(x.Server.URL+"/api/tasks/"+x.Task.ID+"/reports", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var task store.Task
		if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&task) != nil {
			t.Fatal("ready report failed", response.StatusCode)
		}
		return task
	}
	first := post("Source report", []store.Evidence{{Excerpt: "Source one"}, {Excerpt: "Source two"}, {Excerpt: "Source three"}, {Excerpt: "Source four"}})
	second := post("Corrected report", []store.Evidence{{Excerpt: "Corrected fixture plus actual measurement"}})
	if len(second.Evidence) != 1 || second.PreviousDeliveryEvidence == nil || len(second.PreviousDeliveryEvidence.Evidence) != 4 || second.PreviousDeliveryEvidence.ReportEventID != store.CurrentReadyReportID(first) {
		t.Fatal("HTTP sequential reports lost source evidence")
	}
	if err := decision([]string{"-addr", strings.TrimPrefix(x.Server.URL, "http://"), "-task", x.Task.ID, "-run", x.Task.RunID}, io.Discard); err != nil {
		t.Fatal(err)
	}
	after, _ := x.Store.Get(x.Task.ID)
	if !reflect.DeepEqual(second, after) {
		t.Fatal("read-only decision altered snapshot")
	}
	third := post("Third report", []store.Evidence{{Excerpt: "Third result"}})
	if third.PreviousDeliveryEvidence == nil || third.PreviousDeliveryEvidence.ReportEventID != store.CurrentReadyReportID(second) || !reflect.DeepEqual(third.PreviousDeliveryEvidence.Evidence, second.Evidence) {
		t.Fatal("third HTTP report retained more than immediate prior")
	}
}
