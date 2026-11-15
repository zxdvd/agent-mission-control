package main

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
)

func TestCodexJSONLDiscardsKnownItemPreludeWithoutStartOrResultAuthority(t *testing.T) {
	thread := fmt.Sprintf("{\"type\":\"thread.started\",\"thread_id\":%q}\n", fixtureThread)
	turn := "{\"type\":\"turn.started\"}\n"
	complete := "{\"type\":\"turn.completed\"}\n"
	preText := `{"status":"ready","summary":"PRETURN","question":"","options":[],"evidence":[{"label":"Untrusted prelude","excerpt":"Not delivery"}]}`
	item := func(kind, text string) string {
		data, _ := json.Marshal(map[string]any{"type": kind, "item": map[string]string{"type": "agent_message", "text": text}})
		return string(data) + "\n"
	}
	final := item("item.completed", "actual in-turn final")
	for _, kind := range []string{"item.started", "item.updated", "item.completed"} {
		t.Run(kind, func(t *testing.T) {
			observed := 0
			id, result, err := parseCodexJSONLObserved(strings.NewReader(thread+item(kind, preText)+turn+final+complete), fixtureThread, func(string) { observed++ })
			if err != nil || id != fixtureThread || result != "actual in-turn final" || observed != 1 {
				t.Fatal("prelude affected actual turn result", err, observed)
			}
		})
	}
	prelude := item("item.completed", preText)
	for _, tc := range []struct {
		name, stream, expected string
		starts                 int
	}{
		{"item before thread", prelude + thread + turn + final + complete, "", 0},
		{"only prelude", thread + prelude, "", 0},
		{"no real turn", thread + prelude + complete, "", 0},
		{"no in-turn result", thread + prelude + turn + complete, "", 1},
		{"top-level error", thread + prelude + "{\"type\":\"error\"}\n" + turn + final + complete, "", 0},
		{"failed prelude", thread + prelude + "{\"type\":\"turn.failed\"}\n" + turn + final + complete, "", 0},
		{"wrong pinned thread", thread + prelude + turn + final + complete, "11234567-89ab-4cde-8123-456789abcdef", 0},
		{"duplicate thread", thread + prelude + thread + turn + final + complete, "", 0},
		{"duplicate turn", thread + prelude + turn + turn + final + complete, "", 1},
		{"malformed", thread + prelude + "not-json\n" + turn + final + complete, "", 0},
		{"malformed item", thread + "{\"type\":\"item.completed\",\"item\":42}\n" + turn + final + complete, "", 0},
		{"unsupported envelope", thread + "{\"type\":\"item.progress\"}\n" + turn + final + complete, "", 0},
		{"still reject post-completion", thread + prelude + turn + final + complete + prelude, "", 1},
		{"still reject in-turn tool after final", thread + prelude + turn + final + "{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\"}}\n" + complete, "", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			observed := 0
			_, _, err := parseCodexJSONLObserved(strings.NewReader(tc.stream), tc.expected, func(string) { observed++ })
			if err == nil || observed != tc.starts {
				t.Fatal("invalid prelude/turn acquired authority", err, observed)
			}
		})
	}
}

func TestCodexRunKnownItemPreludeKeepsNativeResultAndDecisionBinding(t *testing.T) {
	for _, mode := range []string{"prelude-ready", "prelude-decision"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			var answer <-chan error
			if mode == "prelude-decision" {
				answer = x.answerWhenOpen(t)
			}
			if err := codexRun(x.Args, strings.NewReader("Harmless subprocess fixture only"), io.Discard); err != nil {
				t.Fatal(err)
			}
			if answer != nil {
				if err := <-answer; err != nil {
					t.Fatal(err)
				}
			}
			saved, err := x.Store.Get(x.Task.ID)
			if err != nil {
				t.Fatal(err)
			}
			expectedCalls, expectedEvents := 1, 3
			if mode == "prelude-decision" {
				expectedCalls, expectedEvents = 2, 6
				if len(saved.Commands) != 1 || saved.Commands[0].Status != "acknowledged" {
					t.Fatal("exact decision receipt lost")
				}
			}
			if saved.Status != "ready" || len(saved.Evidence) != 1 || len(saved.Events) != expectedEvents || len(fixtureCalls(t, log)) != expectedCalls {
				t.Fatal("prelude changed lifecycle or delivery")
			}
			data, _ := json.Marshal(saved)
			if strings.Contains(string(data), "PRETURN") {
				t.Fatal("prelude text leaked into saved state")
			}
		})
	}
}
