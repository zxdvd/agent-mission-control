package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCLIDecisionReadbackDoesNotMutate(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "readback.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(store.CreateInput{Title: "Fixture decision", Goal: "Disposable local test", Origin: "test"})
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	h := handler(s)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || r.URL.Path != "/api/tasks/"+task.ID {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		h.ServeHTTP(w, r)
	}))
	defer server.Close()
	args := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", task.ID, "-run", task.RunID}
	read := func(want string) {
		t.Helper()
		before, _ := s.Get(task.ID)
		var out bytes.Buffer
		previousCalls := calls
		if err := decision(args, &out); err != nil {
			t.Fatal(err)
		}
		after, _ := s.Get(task.ID)
		if !reflect.DeepEqual(before, after) || calls != previousCalls+1 {
			t.Fatal("readback mutated state or made more than one request")
		}
		if !strings.Contains(out.String(), want) || !strings.Contains(out.String(), "task="+task.ID+" run="+task.RunID) || !strings.Contains(out.String(), "no delivery acknowledgement sent and no Agent execution") {
			t.Fatal(out.String())
		}
	}
	read("No decision:")
	question := &store.Decision{Question: "Which scope?", Options: []string{"Minimal fix", "Evidence only"}}
	if _, err = s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "needs_decision", Message: "Choose scope", Origin: "test", Decision: question}); err != nil {
		t.Fatal(err)
	}
	read("Waiting for answer:")
	if _, err = s.Apply(task.ID, "decisions", store.Input{RunID: task.RunID, Answer: "Minimal fix"}); err != nil {
		t.Fatal(err)
	}
	read("command=" + task.ID + "-c1 status=recorded\nQuestion: \"Which scope?\"\nAnswer: \"Minimal fix\"")
	read("Recorded answer:") // repeated reads do not acknowledge or append events
	if _, err = s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "progress", Message: "Manual continuation", Origin: "test"}); err != nil {
		t.Fatal(err)
	}
	read("Recorded answer:") // answer remains readable after the open question is cleared
	question.Question = "Review first?"
	if _, err = s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "needs_decision", Message: "New question", Origin: "test", Decision: question}); err != nil {
		t.Fatal(err)
	}
	read("Waiting for answer:") // older answer must not stand in for this question
	args[5] = "stale-run"
	var out bytes.Buffer
	if err = decision(args, &out); err == nil || !strings.Contains(err.Error(), "execution changed") || out.Len() != 0 {
		t.Fatal(err, out.String())
	}
}

func TestCLIDecisionRejectsUnscopedOrRemote(t *testing.T) {
	for _, args := range [][]string{nil, {"-task", "w"}, {"-run", "r"}, {"-task", "w", "-run", "r", "extra"}, {"-task", "w", "-run", "r", "-addr", "example.com:8787"}, {"-task", "w", "-run", "r", "-addr", "localhost:8787"}, {"-task", "w", "-run", "r", "-addr", "0.0.0.0:8787"}} {
		var out bytes.Buffer
		if err := decision(args, &out); err == nil || out.Len() != 0 {
			t.Fatal("accepted", args, out.String())
		}
	}
}

func TestCLIDecisionResponseValidation(t *testing.T) {
	for _, body := range []string{`not JSON`, `{"id":"other","run_id":"r","status":"working"}`, `{"id":"w","run_id":"other","status":"working"}`, `{"id":"w","run_id":"r"}`, `{"id":"w","run_id":"r","status":"needs_decision","decision":{}}`, `{"id":"w","run_id":"r","status":"needs_decision","commands":[{"kind":"decision","run_id":"r"}]}`, strings.Repeat(" ", (1<<20)+1)} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
		var out bytes.Buffer
		err := decision([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r"}, &out)
		server.Close()
		if err == nil || out.Len() != 0 {
			t.Fatal("unexpected response accepted", err, out.String())
		}
	}
}

func TestCLIDecisionDoesNotReturnAnUnofferedOldAnswer(t *testing.T) {
	task := store.Task{ID: "w", RunID: "r", Status: "needs_decision", Decision: &store.Decision{Question: "Which?", Options: []string{"New A", "New B"}}, Commands: []store.Command{{ID: "c1", Kind: "decision", Question: "Which?", Message: "Old A", RunID: "r", Status: "recorded"}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(task) }))
	defer server.Close()
	var out bytes.Buffer
	err := decision([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r"}, &out)
	if err == nil || !strings.Contains(err.Error(), "does not match the current options") || out.Len() != 0 {
		t.Fatal(err, out.String())
	}
}

func TestCLIDecisionIgnoresOtherRunAndReportsExistingStatus(t *testing.T) {
	for _, status := range []string{"recorded", "acknowledged"} {
		task := store.Task{ID: "w", RunID: "r", Status: "working", Commands: []store.Command{{ID: "c1", Kind: "decision", Question: "Current?", Message: "Yes", RunID: "r", Status: status}, {ID: "c2", Kind: "decision", Question: "Other run?", Message: "No", RunID: "other", Status: "recorded"}}}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { json.NewEncoder(w).Encode(task) }))
		var out bytes.Buffer
		err := decision([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r"}, &out)
		server.Close()
		if err != nil || !strings.Contains(out.String(), "command=c1 status="+status) || strings.Contains(out.String(), "Other run?") {
			t.Fatal(err, out.String())
		}
	}
}

func TestCLIDecisionRefusesRedirectAndHTTPError(t *testing.T) {
	for _, code := range []int{http.StatusFound, http.StatusNotFound} {
		calls := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls++
			w.Header().Set("Location", "/unexpected")
			w.WriteHeader(code)
		}))
		var out bytes.Buffer
		err := decision([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r"}, &out)
		server.Close()
		if err == nil || out.Len() != 0 || calls != 1 {
			t.Fatal(err, out.String(), calls)
		}
	}
}

func TestCLIDecisionWaitExactMatchIsReadOnly(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "wait.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(store.CreateInput{Title: "Wait fixture", Goal: "No execution", Origin: "test"})
	if err != nil {
		t.Fatal(err)
	}
	q := &store.Decision{Question: "Which scope?", Options: []string{"Minimal fix", "Evidence only"}}
	if _, err = s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "needs_decision", Message: "Choose", Origin: "test", Decision: q}); err != nil {
		t.Fatal(err)
	}
	// Human choice is the only write while the CLI is waiting. The wait itself
	// may only GET; it must leave precisely the store's recorded state intact.
	calls := 0
	var expected store.Task
	h := handler(s)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || r.URL.Path != "/api/tasks/"+task.ID {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
		if calls == 2 {
			var e error
			expected, e = s.Apply(task.ID, "decisions", store.Input{RunID: task.RunID, Answer: "Minimal fix"})
			if e != nil {
				t.Error(e)
			}
		}
		h.ServeHTTP(w, r)
	}))
	defer server.Close()
	args := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", task.ID, "-run", task.RunID, "-wait", "2s", "-question", q.Question}
	var out bytes.Buffer
	if err = decision(args, &out); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 2 || !reflect.DeepEqual(got, expected) || len(got.Commands) != 1 || got.Commands[0].Status != "recorded" {
		t.Fatal("wait mutated store", calls, got)
	}
	want := fmt.Sprintf("Recorded answer: task=%s run=%s command=%s status=recorded\nQuestion: %q\nAnswer: %q\nRead-only snapshot; no delivery acknowledgement sent and no Agent execution.\n", task.ID, task.RunID, got.Commands[0].ID, q.Question, "Minimal fix")
	if out.String() != want {
		t.Fatalf("got %q want %q", out.String(), want)
	}
	out.Reset()
	if err = decision(args, &out); err != nil {
		t.Fatal(err)
	}
	after, _ := s.Get(task.ID)
	if calls != 3 || !reflect.DeepEqual(got, after) || out.String() != want {
		t.Fatal("repeat wait acknowledged or changed answer", calls, out.String())
	}
	acknowledged, err := s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "receipt", CommandID: got.Commands[0].ID, Origin: "explicit test consumer"})
	if err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err = decision(args, &out); err == nil || !strings.Contains(err.Error(), "answer already acknowledged") || out.Len() != 0 {
		t.Fatal("wait replayed acknowledged answer", err, out.String())
	}
	after, _ = s.Get(task.ID)
	if !reflect.DeepEqual(acknowledged, after) {
		t.Fatal("rejected wait changed store")
	}
}

func TestCLIDecisionWaitDeadlineBoundsHTTPAndSleep(t *testing.T) {
	for _, hang := range []bool{false, true} {
		t.Run(fmt.Sprint(hang), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != "GET" {
					t.Errorf("unexpected %s", r.Method)
				}
				if hang { // Include a partial body: deadline must bound body reads too.
					fmt.Fprint(w, `{"id":`)
					w.(http.Flusher).Flush()
					<-r.Context().Done()
					return
				}
				json.NewEncoder(w).Encode(store.Task{ID: "w", RunID: "r", Status: "needs_decision", Decision: &store.Decision{Question: "Which?", Options: []string{"A", "B"}}, Commands: []store.Command{{ID: "old", Kind: "decision", Question: "Old?", Message: "A", RunID: "r", Status: "recorded"}, {ID: "other-run", Kind: "decision", Question: "Which?", Message: "A", RunID: "old-r", Status: "recorded"}}})
			}))
			defer server.Close()
			var out bytes.Buffer
			start := time.Now()
			err := decision([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r", "-wait", "60ms", "-question", "Which?"}, &out)
			if err == nil || !strings.Contains(err.Error(), "decision wait timed out: task=w run=r") || out.Len() != 0 || time.Since(start) > time.Second || calls.Load() != 1 {
				t.Fatal(err, out.String(), time.Since(start), calls.Load())
			}
			before := calls.Load()
			time.Sleep(2 * decisionPollInterval)
			if calls.Load() != before {
				t.Fatal("polling continued after timeout")
			}
		})
	}
}

func TestCLIDecisionWaitStopsOnReplacementOrMalformedAnswer(t *testing.T) {
	for _, tc := range []struct {
		name, want string
		change     func(*store.Task)
	}{
		{"question", "question or task state changed", func(s *store.Task) { s.Decision.Question = "New question?" }},
		{"cleared", "question or task state changed", func(s *store.Task) { s.Decision = nil }},
		{"options", "options changed", func(s *store.Task) { s.Decision.Options[1] = "C" }},
		{"run", "execution changed", func(s *store.Task) { s.RunID = "new-r" }},
		{"terminal", "question or task state changed", func(s *store.Task) { s.Status = "done" }},
		{"duplicate", "duplicate decision record", func(s *store.Task) { s.Commands = append(s.Commands, s.Commands[0]) }},
		{"invalid answer", "unexpected or duplicate", func(s *store.Task) { s.Commands[0].Message = "not offered" }},
		{"invalid status", "unexpected or duplicate", func(s *store.Task) { s.Commands[0].Status = "delivered" }},
		{"acknowledged", "answer already acknowledged; inspect the prior consumer outcome", func(s *store.Task) { s.Commands[0].Status = "acknowledged" }},
		{"blank option", "unexpected open question options", func(s *store.Task) { s.Decision.Options[1] = " " }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != "GET" {
					t.Errorf("unexpected %s", r.Method)
				}
				saved := store.Task{ID: "w", RunID: "r", Status: "needs_decision", Decision: &store.Decision{Question: "Which?", Options: []string{"A", "B"}}}
				if calls == 2 {
					saved.Commands = []store.Command{{ID: "c", Kind: "decision", Question: "Which?", Message: "A", RunID: "r", Status: "recorded"}}
					tc.change(&saved)
				}
				json.NewEncoder(w).Encode(saved)
			}))
			defer server.Close()
			var out bytes.Buffer
			err := decision([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r", "-wait", "2s", "-question", "Which?"}, &out)
			if err == nil || !strings.Contains(err.Error(), tc.want) || out.Len() != 0 || calls != 2 {
				t.Fatal(err, out.String(), calls)
			}
		})
	}
}

func TestCLIDecisionWaitStopsOnReadError(t *testing.T) {
	for _, body := range []string{`not JSON`, `{"id":"other","run_id":"r","status":"needs_decision"}`, strings.Repeat(" ", (1<<20)+1)} {
		calls := 0
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; fmt.Fprint(w, body) }))
		var out bytes.Buffer
		err := decision([]string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r", "-wait", "2s", "-question", "Which?"}, &out)
		server.Close()
		if err == nil || out.Len() != 0 || calls != 1 {
			t.Fatal(err, out.String(), calls)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	addr := strings.TrimPrefix(server.URL, "http://")
	server.Close()
	var out bytes.Buffer
	if err := decision([]string{"-addr", addr, "-task", "w", "-run", "r", "-wait", "2s", "-question", "Which?"}, &out); err == nil || !strings.Contains(err.Error(), "decision read failed") || out.Len() != 0 {
		t.Fatal(err, out.String())
	}
}

func TestCLIDecisionWaitValidationBeforeRead(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; t.Error("invalid flags reached server") }))
	defer server.Close()
	base := []string{"-addr", strings.TrimPrefix(server.URL, "http://"), "-task", "w", "-run", "r"}
	for _, extra := range [][]string{{"-wait", "1s"}, {"-wait", "1s", "-question", " "}, {"-question", "Which?"}, {"-wait", "0", "-question", "Which?"}, {"-wait", "-1s", "-question", "Which?"}, {"-wait", "301s", "-question", "Which?"}, {"-wait", "forever", "-question", "Which?"}} {
		var out bytes.Buffer
		if err := decision(append(append([]string{}, base...), extra...), &out); err == nil || out.Len() != 0 {
			t.Fatal("accepted", extra, err, out.String())
		}
	}
	if calls != 0 {
		t.Fatal(calls)
	}
}
