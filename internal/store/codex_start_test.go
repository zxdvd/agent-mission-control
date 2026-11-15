package store

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

const startThread = "01234567-89ab-4cde-8123-456789abcdef"

func TestCodexStartObservationIsIndependentImmutableAndDurable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "start.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(CreateInput{Title: "Fixture", Goal: "No native execution", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ObserveCodexStart(task.ID, task.RunID, startThread); !errors.Is(err, ErrConflict) {
		t.Fatal("accepted without claim", err)
	}
	task, err = s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	start, err := s.ObserveCodexStart(task.ID, task.RunID, startThread)
	if err != nil {
		t.Fatal(err)
	}
	if start.RunID != task.RunID || start.NativeThreadID != startThread {
		t.Fatal(start)
	}
	if _, err = time.Parse(time.RFC3339Nano, start.ObservedAt); err != nil {
		t.Fatal(err)
	}
	saved, _ := s.Get(task.ID)
	without := saved
	without.CodexStart = nil
	if !reflect.DeepEqual(task, without) {
		t.Fatal("observation changed lifecycle/events", task, saved)
	}
	for _, tc := range []struct{ run, id string }{{task.RunID, startThread}, {"stale-run", startThread}, {task.RunID, "11234567-89ab-4cde-8123-456789abcdef"}} {
		if _, err = s.ObserveCodexStart(task.ID, tc.run, tc.id); !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
		after, _ := s.Get(task.ID)
		if !reflect.DeepEqual(saved, after) {
			t.Fatal("overwrote observation", after)
		}
	}
	binding := &CodexBinding{Version: 1, TaskID: task.ID, RunID: task.RunID, NativeThreadID: startThread, Question: "Scope?", Options: []string{"A", "B"}, CWDFingerprint: "sha256:" + strings.Repeat("a", 64), Sandbox: "read-only"}
	saved, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "needs_decision", Message: "Choose", Origin: "fixture", Decision: &Decision{Question: binding.Question, Options: binding.Options}, CodexBinding: binding})
	if err != nil || !SameCodexBinding(saved.CodexBinding, binding) || saved.CodexStart == nil || *saved.CodexStart != start {
		t.Fatal("observation broke first-decision binding", err, saved)
	}
	saved, err = s.Apply(task.ID, "decisions", Input{RunID: task.RunID, Answer: "A", Decision: saved.Decision})
	if err != nil {
		t.Fatal(err)
	}
	saved, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "receipt", Origin: "fixture", CommandID: saved.Commands[0].ID, CodexBinding: binding})
	if err != nil || saved.Commands[0].Status != "acknowledged" {
		t.Fatal(err, saved)
	}
	saved, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "failed", Message: "Native failure after start", Origin: "fixture"})
	if err != nil || saved.CodexStart == nil || *saved.CodexStart != start {
		t.Fatal(err, saved)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	saved, err = s.Get(task.ID)
	if err != nil || saved.CodexStart == nil || *saved.CodexStart != start {
		t.Fatal("historical start lost on report/reopen", err, saved)
	}
}

func TestCodexStartObservationGuardPreservesOtherState(t *testing.T) {
	for _, state := range []string{"stale-run", "invalid-uuid", "synthetic", "progress", "needs_decision", "ready", "completed", "failed"} {
		t.Run(state, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "guard.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			task, err := s.Create(CreateInput{Title: "Fixture", Goal: "Guard", Origin: "fixture"})
			if err != nil {
				t.Fatal(err)
			}
			task, err = s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture"})
			if err != nil {
				t.Fatal(err)
			}
			run, id := task.RunID, startThread
			switch state {
			case "stale-run":
				run = "old-run"
			case "invalid-uuid":
				id = "not-a-uuid"
			case "synthetic":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.source','synthetic') WHERE id=?`, task.ID)
			default:
				task, err = s.Apply(task.ID, "reports", Input{RunID: run, Kind: state, Message: "Authoritative state", Origin: "fixture", Decision: &Decision{Question: "Scope?", Options: []string{"A", "B"}}, Evidence: []Evidence{{Label: "Fixture", Excerpt: "Evidence"}}})
			}
			if err != nil {
				t.Fatal(err)
			}
			before, _ := s.Get(task.ID)
			if _, err = s.ObserveCodexStart(task.ID, run, id); err == nil {
				t.Fatal("accepted stale/invalid observation")
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("guard mutated state", before, after)
			}
		})
	}
}
