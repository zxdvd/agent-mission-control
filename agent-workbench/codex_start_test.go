package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexJSONLStartObservationRequiresValidatedEnvelope(t *testing.T) {
	thread := fmt.Sprintf("{\"type\":\"thread.started\",\"thread_id\":%q}\n", fixtureThread)
	for _, tc := range []struct {
		name, stream, expected string
		count                  int
	}{
		{"no thread", `{"type":"turn.started"}`, "", 0},
		{"bad UUID", "{\"type\":\"thread.started\",\"thread_id\":\"invalid\"}\n{\"type\":\"turn.started\"}", "", 0},
		{"thread only", thread, "", 0},
		{"wrong thread", thread + "{\"type\":\"turn.started\"}", "11234567-89ab-4cde-8123-456789abcdef", 0},
		{"duplicate thread", thread + thread + "{\"type\":\"turn.started\"}", "", 0},
		{"malformed before turn", thread + "not-json\n{\"type\":\"turn.started\"}", "", 0},
		{"observed then failure", thread + "{\"type\":\"turn.started\"}\n{\"type\":\"turn.failed\"}", "", 1},
		{"first turn only", thread + "{\"type\":\"turn.started\"}\n{\"type\":\"turn.started\"}", "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var observed []string
			_, _, err := parseCodexJSONLObserved(strings.NewReader(tc.stream), tc.expected, func(id string) { observed = append(observed, id) })
			if err == nil || len(observed) != tc.count || (len(observed) > 0 && observed[0] != fixtureThread) {
				t.Fatal(err, observed)
			}
		})
	}
}

func waitStartObservation(t *testing.T, x *codexHTTPFixture, done <-chan error) store.Task {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			t.Fatalf("native returned before controlled release: %v", err)
		default:
		}
		saved, err := x.Store.Get(x.Task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if saved.CodexStart != nil {
			return saved
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("start fact not visible while native process is still running")
	return store.Task{}
}

func TestCodexStartStreamsBeforeExitAndSurvivesFinalReport(t *testing.T) {
	for _, mode := range []string{"controlled-ready", "controlled-failure", "controlled-decision"} {
		t.Run(mode, func(t *testing.T) {
			fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			release := filepath.Join(x.Cwd, "release")
			t.Setenv("AWB_FAKE_RELEASE", release)
			var out bytes.Buffer
			done := make(chan error, 1)
			go func() { done <- codexRun(x.Args, strings.NewReader("Fixture only"), &out) }()
			saved := waitStartObservation(t, x, done)
			start := *saved.CodexStart
			if saved.Status != "working" || len(saved.Events) != 2 || saved.Events[1].Kind != "codex-start:" || saved.ObservedAt != "" || start.NativeThreadID != fixtureThread || start.RunID != saved.RunID {
				t.Fatal("observation disturbed claim", saved)
			}
			var answered <-chan error
			if mode == "controlled-decision" {
				answered = x.answerWhenOpen(t)
			}
			if err := os.WriteFile(release, []byte("release"), 0600); err != nil {
				t.Fatal(err)
			}
			err := <-done
			if (mode == "controlled-failure") != (err != nil) {
				t.Fatal(err, out.String())
			}
			if answered != nil {
				if err := <-answered; err != nil {
					t.Fatal(err)
				}
			}
			saved, _ = x.Store.Get(x.Task.ID)
			if saved.CodexStart == nil || *saved.CodexStart != start {
				t.Fatal("main report lost initial fact", saved)
			}
			expected := "ready"
			if mode == "controlled-failure" {
				expected = "blocked"
			}
			if saved.Status != expected {
				t.Fatal(err, saved)
			}
			observationPosts := 0
			for _, path := range x.Posts {
				if strings.HasSuffix(path, "/codex-observed-start") {
					observationPosts++
				}
			}
			if observationPosts != 1 {
				t.Fatal("resume or retry added observation", x.Posts)
			}
		})
	}
}

func TestCodexPreTurnFailureNeverRecordsStart(t *testing.T) {
	fakeCodex(t, "pre-turn-failure")
	x := newCodexHTTPFixture(t, nil)
	if err := codexRun(x.Args, strings.NewReader("Fixture"), io.Discard); err == nil {
		t.Fatal("expected failure")
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if saved.CodexStart != nil || saved.Status != "blocked" {
		t.Fatal(saved)
	}
	for _, path := range x.Posts {
		if strings.HasSuffix(path, "/codex-observed-start") {
			t.Fatal("observed pre-turn failure")
		}
	}
}

func TestCodexStartDisplayDeliveryCannotGateAuthoritativeExecution(t *testing.T) {
	for _, mode := range []string{"rejected", "ambiguous", "slow"} {
		t.Run(mode, func(t *testing.T) {
			fakeCodex(t, "controlled-ready")
			observed := make(chan struct{})
			x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, h http.Handler) bool {
				if !strings.HasSuffix(r.URL.Path, "/codex-observed-start") {
					return false
				}
				close(observed)
				switch mode {
				case "rejected":
					w.WriteHeader(503)
				case "ambiguous":
					h.ServeHTTP(w, r) // valid commit; CLI must not depend on response
				case "slow":
					io.Copy(io.Discard, r.Body)
					<-r.Context().Done()
				}
				return true
			})
			release := filepath.Join(x.Cwd, "release")
			t.Setenv("AWB_FAKE_RELEASE", release)
			done := make(chan error, 1)
			go func() { done <- codexRun(x.Args, strings.NewReader("Fixture"), io.Discard) }()
			select {
			case <-observed:
			case <-time.After(2 * time.Second):
				t.Fatal("no display write")
			}
			if err := os.WriteFile(release, []byte("release"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := <-done; err != nil {
				t.Fatal("display write changed execution", err)
			}
			saved, _ := x.Store.Get(x.Task.ID)
			if saved.Status != "ready" || len(saved.Events) != 3 || saved.Events[2].Kind != "reports:ready" {
				t.Fatal("display write changed lifecycle", saved)
			}
		})
	}
}
