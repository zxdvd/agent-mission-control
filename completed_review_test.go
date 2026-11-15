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

func TestCLICompletedQueuesReadyWithExactHTTPReviewAndEnd(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	args := []string{"-addr", strings.TrimPrefix(x.Server.URL, "http://"), "-task", x.Task.ID, "-run", x.Task.RunID, "-kind", "completed", "-message", "Reporter claims completion", "-origin", "fixture manual relay", "-excerpt", "Newly supplied evidence"}
	var out bytes.Buffer
	if err := report(args, &out); err != nil {
		t.Fatal(err)
	}
	ready, _ := x.Store.Get(x.Task.ID)
	id := store.CurrentReadyReportID(ready)
	if ready.Status != "ready" || id == "" || ready.Events[len(ready.Events)-1].Kind != "reports:completed" || !strings.Contains(out.String(), "Saved completed report:") || !strings.Contains(out.String(), "status=ready report="+id) {
		t.Fatal("CLI did not queue exact completed claim")
	}
	post := func(action string, fields map[string]string) int {
		fields["run_id"] = ready.RunID
		fields["report_event_id"] = id
		data, _ := json.Marshal(fields)
		res, err := http.Post(x.Server.URL+"/api/tasks/"+ready.ID+"/"+action, "application/json", bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if code := post("local-follow-up", map[string]string{"operation": "end"}); code != 409 {
		t.Fatal("unread report ended", code)
	}
	if code := post("review-delivery", map[string]string{}); code != 200 {
		t.Fatal("completed claim not reviewable", code)
	}
	if code := post("local-follow-up", map[string]string{"operation": "end"}); code != 200 {
		t.Fatal("viewed report not endable", code)
	}
	ended, _ := x.Store.Get(ready.ID)
	unchanged := ended
	unchanged.DeliveryReview = nil
	unchanged.LocalFollowUp = nil
	if !reflect.DeepEqual(ready, unchanged) || ended.Status != "ready" || ended.DeliveryReview.ReportEventID != id || ended.LocalFollowUp.ReportEventID != id {
		t.Fatal("review/end changed authoritative delivery")
	}
	out.Reset()
	// The same report kind creates new evidence identity, not a renewed old view.
	if err := report(args, &out); err != nil {
		t.Fatal(err)
	}
	newer, _ := x.Store.Get(ready.ID)
	if store.CurrentReadyReportID(newer) == id {
		t.Fatal("replacement reused report identity")
	}
	if code := post("review-delivery", map[string]string{}); code != 409 {
		t.Fatal("stale HTTP review accepted", code)
	}
	if code := post("local-follow-up", map[string]string{"operation": "resume", "expected_recorded_at": ended.LocalFollowUp.RecordedAt}); code != 409 {
		t.Fatal("stale HTTP restore accepted", code)
	}
	after, _ := x.Store.Get(ready.ID)
	if !reflect.DeepEqual(newer, after) {
		t.Fatal("stale request mutated replacement")
	}
}

func TestCLICompletedDoesNotConfirmLegacyDoneOrUnreviewableReceipt(t *testing.T) {
	for _, mode := range []string{"legacy-done", "missing-evidence", "nonlocal", "wrong-run"} {
		t.Run(mode, func(t *testing.T) {
			task := store.Task{ID: "w", RunID: "r", Source: "local", ProjectID: "local", Status: "ready", Evidence: []store.Evidence{{Excerpt: "Supplied result"}}, Events: []store.Event{{ID: "e", RunID: "r", Kind: "reports:completed"}}}
			switch mode {
			case "legacy-done":
				task.Status = "done"
			case "missing-evidence":
				task.Evidence = nil
			case "nonlocal":
				task.Source = "synthetic"
			case "wrong-run":
				task.RunID = "old-run"
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(task) }))
			defer server.Close()
			var out bytes.Buffer
			err := report([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r", "-kind", "completed", "-message", "Claim", "-origin", "fixture", "-excerpt", "Result"}, &out)
			if err == nil || !strings.Contains(err.Error(), "delivery unconfirmed") || out.Len() != 0 {
				t.Fatal("unreviewable receipt claimed success", err, out.String())
			}
		})
	}
}
