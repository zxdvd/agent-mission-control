package store

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func freshBoundDecision(t *testing.T) (*Store, Task, *CodexBinding) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "bound.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	task, err := s.Create(CreateInput{Title: "Bound fixture", Goal: "No native execution", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	task, err = s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	b := &CodexBinding{Version: 1, NativeThreadID: "01234567-89ab-4cde-8123-456789abcdef", TaskID: task.ID, RunID: task.RunID, Question: "Which scope?", Options: []string{"A", "B"}, CWDFingerprint: "sha256:" + strings.Repeat("a", 64), Sandbox: "read-only"}
	task, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "needs_decision", Message: "Choose", Origin: "fixture", Decision: &Decision{Question: b.Question, Options: b.Options}, CodexBinding: b})
	if err != nil {
		t.Fatal(err)
	}
	return s, task, b
}

func TestCodexBindingIsAtomicAndReceiptMatchesCurrentDecision(t *testing.T) {
	for _, field := range []string{"uuid", "cwd", "sandbox", "run", "question", "options", "missing"} {
		t.Run(field, func(t *testing.T) {
			s, task, b := freshBoundDecision(t)
			task, err := s.Apply(task.ID, "decisions", Input{RunID: task.RunID, Answer: "A", Decision: task.Decision})
			if err != nil {
				t.Fatal(err)
			}
			changed := *b
			changed.Options = append([]string{}, b.Options...)
			supplied := &changed
			switch field {
			case "uuid":
				changed.NativeThreadID = "11234567-89ab-4cde-8123-456789abcdef"
			case "cwd":
				changed.CWDFingerprint = "sha256:" + strings.Repeat("b", 64)
			case "sandbox":
				changed.Sandbox = "workspace-write"
			case "run":
				changed.RunID = "other-run"
			case "question":
				changed.Question = "Other?"
			case "options":
				changed.Options[1] = "C"
			case "missing":
				supplied = nil
			}
			_, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "receipt", CommandID: task.Commands[0].ID, Origin: "fixture", CodexBinding: supplied})
			after, _ := s.Get(task.ID)
			if !errors.Is(err, ErrConflict) || !reflect.DeepEqual(task, after) {
				t.Fatal("bad receipt mutated", err, after)
			}
			after, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "receipt", CommandID: task.Commands[0].ID, Origin: "fixture", CodexBinding: b})
			if err != nil || after.Commands[0].Status != "acknowledged" {
				t.Fatal(err, after)
			}
			if _, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "receipt", CommandID: task.Commands[0].ID, Origin: "fixture", CodexBinding: b}); !errors.Is(err, ErrConflict) {
				t.Fatal("receipt reused", err)
			}
		})
	}
}

func TestCodexBindingCannotBeInstalledWithoutFreshClaimOrRebound(t *testing.T) {
	s, task, b := freshBoundDecision(t)
	// A later report with metadata cannot swap even a syntactically valid UUID.
	changed := *b
	changed.NativeThreadID = "11234567-89ab-4cde-8123-456789abcdef"
	report := Input{RunID: task.RunID, Kind: "needs_decision", Message: "Replace", Origin: "fixture", Decision: task.Decision, CodexBinding: &changed}
	if _, err := s.Apply(task.ID, "reports", report); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	// An ordinary report deliberately invalidates the continuation binding.
	task, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "progress", Message: "Manual work", Origin: "fixture"})
	if err != nil || task.CodexBinding != nil {
		t.Fatal(err, task)
	}
	if _, err = s.Apply(task.ID, "reports", report); !errors.Is(err, ErrConflict) {
		t.Fatal("rebound", err)
	}
	fresh, err := s.Create(CreateInput{Title: "No claim", Goal: "Unstarted", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	changed.TaskID = fresh.ID
	changed.RunID = fresh.RunID
	report.RunID = fresh.RunID
	if _, err = s.Apply(fresh.ID, "reports", report); !errors.Is(err, ErrConflict) {
		t.Fatal("unclaimed UUID accepted", err)
	}
}

func TestDecisionUsesExactObservedQuestionAndOptions(t *testing.T) {
	s, task, _ := freshBoundDecision(t)
	for _, observed := range []*Decision{nil, {Question: "Older question", Options: task.Decision.Options}, {Question: task.Decision.Question, Options: []string{"A", "C"}}} {
		_, err := s.Apply(task.ID, "decisions", Input{RunID: task.RunID, Answer: "A", Decision: observed})
		after, _ := s.Get(task.ID)
		if !errors.Is(err, ErrConflict) || !reflect.DeepEqual(task, after) {
			t.Fatal("stale or absent question accepted", err, after)
		}
	}
	// Same run, replacement question, overlapping A option: the old browser
	// selection must not silently answer the replacement question.
	old := task.Decision
	task, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "needs_decision", Message: "New question", Origin: "fixture", Decision: &Decision{Question: "Replacement?", Options: []string{"A", "C"}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Apply(task.ID, "decisions", Input{RunID: task.RunID, Answer: "A", Decision: old}); !errors.Is(err, ErrConflict) {
		t.Fatal("old question answered replacement", err)
	}
	if _, err = s.Apply(task.ID, "decisions", Input{RunID: task.RunID, Answer: "A", Decision: task.Decision}); err != nil {
		t.Fatal(err)
	}
}
