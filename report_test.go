package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCLIReportExactLocalRun(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "cli.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(store.CreateInput{Title: "Disposable bugfix", Goal: "Fixture only", Origin: "test owner"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler(s))
	defer server.Close()
	args := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", task.ID, "-run", task.RunID, "-kind", "ready", "-message", "fixture fixed", "-origin", "manual relay; no dispatch", "-excerpt", "8 tests passed"}
	var out bytes.Buffer
	if err = report(args, &out); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(task.ID)
	if got.Status != "ready" || got.Evidence[0].Excerpt != "8 tests passed" || !strings.Contains(out.String(), task.ID) || !strings.Contains(out.String(), "status=ready") {
		t.Fatal(got, out.String())
	}
	args[5] = "stale-run" // -run value, not work ID
	if err = report(args, &out); err == nil {
		t.Fatal("accepted stale run")
	}
	got, _ = s.Get(task.ID)
	if len(got.Events) != 2 {
		t.Fatal("rejected report persisted", got.Events)
	}
}
func TestCLIRejectsRemoteAndIncomplete(t *testing.T) {
	for _, args := range [][]string{nil, {"-task", "w", "-run", "r", "-message", "m", "-origin", "o", "-addr", "example.com:8787"}, {"-task", "w", "-run", "r", "-message", "m", "-origin", "o", "-addr", "0.0.0.0:8787"}, {"-task", "w", "-run", "r", "-message", "m", "-origin", "o", "-kind", "receipt"}} {
		if err := report(args, &bytes.Buffer{}); err == nil {
			t.Fatal("accepted", args)
		}
	}
}

func TestCLIReportDecisionExactLocalRun(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "decision.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(store.CreateInput{Title: "Disposable decision", Goal: "Fixture only", Origin: "test owner"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler(s))
	defer server.Close()
	args := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", task.ID, "-run", task.RunID, "-kind", "needs_decision", "-message", "scope needs a choice", "-origin", "manual relay; no dispatch", "-question", " Which scope? ", "-option", " Minimal fix ", "-option", "Evidence only", "-option", strings.Repeat("界", 120), "-excerpt", "Two approaches found"}
	var out bytes.Buffer
	if err = report(args, &out); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "needs_decision" || got.Decision == nil || got.Decision.Question != "Which scope?" || len(got.Decision.Options) != 3 || got.Decision.Options[0] != "Minimal fix" || got.Decision.Options[1] != "Evidence only" || len(got.Commands) != 0 {
		t.Fatalf("unexpected saved decision: %+v", got)
	}
	event := got.Events[len(got.Events)-1]
	if event.Origin != "manual relay; no dispatch" || got.Evidence[0].Excerpt != "Two approaches found" {
		t.Fatal(got)
	}
	want := fmt.Sprintf("Saved needs_decision report: task=%s run=%s status=needs_decision report=%s\nRecorded locally only; no Agent execution or automatic delivery.\n", task.ID, task.RunID, event.ID)
	if out.String() != want {
		t.Fatalf("output = %q, want %q", out.String(), want)
	}
	out.Reset()
	args[5] = "stale-run"
	if err = report(args, &out); err == nil || !strings.Contains(err.Error(), "409") || out.Len() != 0 {
		t.Fatal("stale run not rejected clearly", err, out.String())
	}
	got, _ = s.Get(task.ID)
	if len(got.Events) != 2 || got.RunID != task.RunID || got.Decision.Question != "Which scope?" {
		t.Fatal("stale report changed saved decision", got)
	}
}

func TestCLIDecisionValidationBeforeDelivery(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		http.Error(w, "must not reach server", http.StatusBadRequest)
	}))
	defer server.Close()
	base := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "work-fixture", "-run", "work-fixture-run-1", "-message", "choice needed", "-origin", "test"}
	for _, tc := range []struct {
		name string
		args []string
	}{
		{"missing question", []string{"-kind", "needs_decision", "-option", "A", "-option", "B"}},
		{"blank question", []string{"-kind", "needs_decision", "-question", " \t", "-option", "A", "-option", "B"}},
		{"missing options", []string{"-kind", "needs_decision", "-question", "Which?"}},
		{"one option", []string{"-kind", "needs_decision", "-question", "Which?", "-option", "A"}},
		{"blank option", []string{"-kind", "needs_decision", "-question", "Which?", "-option", " ", "-option", "B"}},
		{"duplicate option", []string{"-kind", "needs_decision", "-question", "Which?", "-option", " A ", "-option", "A"}},
		{"long option", []string{"-kind", "needs_decision", "-question", "Which?", "-option", strings.Repeat("界", 121), "-option", "B"}},
		{"question on other kind", []string{"-kind", "progress", "-question", "Which?"}},
		{"option on other kind", []string{"-kind", "ready", "-option", "A"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			if err := report(append(append([]string{}, base...), tc.args...), &out); err == nil || out.Len() != 0 {
				t.Fatal("invalid decision accepted", err, out.String())
			}
		})
	}
	if calls != 0 {
		t.Fatal("invalid decision sent", calls)
	}
}

func TestCLIUnexpectedReceiptDoesNotClaimSaved(t *testing.T) {
	for _, body := range []string{
		`not JSON`,
		`{"id":"other","run_id":"r","status":"needs_decision","events":[{"id":"e","run_id":"r","kind":"reports:needs_decision"}]}`,
		`{"id":"w","run_id":"other","status":"needs_decision","events":[{"id":"e","run_id":"r","kind":"reports:needs_decision"}]}`,
		`{"id":"w","run_id":"r","status":"needs_decision","events":[]}`,
		`{"id":"w","run_id":"r","status":"needs_decision","events":[{"id":"e","run_id":"r","kind":"reports:progress"}]}`,
	} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
			defer server.Close()
			var out bytes.Buffer
			err := report([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r", "-message", "m", "-origin", "test", "-kind", "needs_decision", "-question", "Which?", "-option", "A", "-option", "B"}, &out)
			if err == nil || !strings.Contains(err.Error(), "delivery unconfirmed") || out.Len() != 0 {
				t.Fatal("unexpected receipt claimed success", err, out.String())
			}
		})
	}
}
func TestCreateHTTPAndOriginGuard(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "http.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, tc := range []struct {
		body, origin, host string
		status             int
	}{
		{`{"title":"Bugfix","goal":"Fixture only","origin":"Owner"}`, "", "127.0.0.1:8787", 201},
		{`{"title":"Bugfix","goal":"Fixture only","origin":"Owner","source":"synthetic"}`, "", "127.0.0.1:8787", 400},
		{`{"title":"Bad origin","goal":"Fixture only","origin":"Owner"}`, "https://other.test", "127.0.0.1:8787", 403},
		{`{"title":"Bad host","goal":"Fixture only","origin":"Owner"}`, "", "remote.test", 403},
	} {
		r := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(tc.body))
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		w := httptest.NewRecorder()
		handler(s).ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	items, _ := s.List()
	if len(items) != 1 {
		t.Fatal(items)
	}
}

func TestCLIReceiptAcknowledgesOnlyExactCommandOnce(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "receipt.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(store.CreateInput{Title: "Receipt fixture", Goal: "No execution", Origin: "test"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "needs_decision", Message: "Choose", Origin: "test", Decision: &store.Decision{Question: "Which?", Options: []string{"A", "B"}}}); err != nil {
		t.Fatal(err)
	}
	before, err := s.Apply(task.ID, "decisions", store.Input{RunID: task.RunID, Answer: "A"})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler(s))
	defer server.Close()
	args := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", task.ID, "-run", task.RunID, "-kind", "receipt", "-command", before.Commands[0].ID, "-origin", "explicit test consumer"}
	for _, tc := range []struct {
		index       int
		value, want string
	}{{5, "stale-run", "409"}, {9, "unknown", "400"}} {
		bad := append([]string{}, args...)
		bad[tc.index] = tc.value
		var out bytes.Buffer
		err = report(bad, &out)
		after, _ := s.Get(task.ID)
		if err == nil || !strings.Contains(err.Error(), tc.want) || out.Len() != 0 || !reflect.DeepEqual(before, after) {
			t.Fatal("bad receipt changed store", err, out.String(), after)
		}
	}
	var out bytes.Buffer
	if err = report(args, &out); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(task.ID)
	if len(got.Commands) != 1 || got.Commands[0].Status != "acknowledged" || got.Status != before.Status || got.Summary != before.Summary || !reflect.DeepEqual(got.Decision, before.Decision) || !reflect.DeepEqual(got.Evidence, before.Evidence) || len(got.Events) != len(before.Events)+1 {
		t.Fatal(got)
	}
	event := got.Events[len(got.Events)-1]
	if event.Origin != "explicit test consumer" || event.Kind != "reports:receipt" {
		t.Fatal(event)
	}
	want := fmt.Sprintf("Saved receipt report: task=%s run=%s status=%s report=%s command=%s command_status=acknowledged\nRecorded locally only; acknowledgement is reporter-supplied, not proof of Agent execution or continuation.\n", task.ID, task.RunID, got.Status, event.ID, got.Commands[0].ID)
	if out.String() != want {
		t.Fatalf("got %q want %q", out.String(), want)
	}
	out.Reset()
	if err = report(args, &out); err == nil || !strings.Contains(err.Error(), "409") || !strings.Contains(err.Error(), "already acknowledged") || out.Len() != 0 {
		t.Fatal(err, out.String())
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(got, after) {
		t.Fatal("duplicate receipt persisted", after)
	}
}

func TestCLIReceiptValidationBeforeDelivery(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; t.Error("invalid receipt reached server") }))
	defer server.Close()
	base := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r", "-origin", "test"}
	for _, extra := range [][]string{
		{"-kind", "receipt"}, {"-kind", "receipt", "-command", " "},
		{"-kind", "receipt", "-command", "c", "-excerpt", "evidence"},
		{"-kind", "receipt", "-command", "c", "-question", "Which?"},
		{"-kind", "receipt", "-command", "c", "-option", "A"},
		{"-kind", "progress", "-command", "c", "-message", "m"},
		{"-kind", "progress"},
	} {
		var out bytes.Buffer
		if err := report(append(append([]string{}, base...), extra...), &out); err == nil || out.Len() != 0 {
			t.Fatal("accepted", extra, err, out.String())
		}
	}
	if calls != 0 {
		t.Fatal(calls)
	}
}

func TestCLIReceiptResponseMustConfirmOneExactAcknowledgement(t *testing.T) {
	for _, commands := range []string{
		`[]`,
		`[{"id":"other","run_id":"r","status":"acknowledged"}]`,
		`[{"id":"c","run_id":"old-r","status":"acknowledged"}]`,
		`[{"id":"c","run_id":"r","status":"recorded"}]`,
		`[{"id":"c","run_id":"r","status":"acknowledged"},{"id":"c","run_id":"r","status":"acknowledged"}]`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			fmt.Fprintf(w, `{"id":"w","run_id":"r","status":"needs_decision","events":[{"id":"e","run_id":"r","kind":"reports:receipt"}],"commands":%s}`, commands)
		}))
		var out bytes.Buffer
		err := report([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r", "-kind", "receipt", "-command", "c", "-origin", "test"}, &out)
		server.Close()
		if err == nil || !strings.Contains(err.Error(), "delivery unconfirmed") || out.Len() != 0 {
			t.Fatal(err, out.String())
		}
	}
}
