package store

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func failedPrestart(t *testing.T) (*Store, Task) {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "retry.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	task, err := s.Create(CreateInput{Title: "Same task", Goal: "Explicitly bounded goal", Origin: "fixture", ProjectName: "Personal project"})
	if err != nil {
		t.Fatal(err)
	}
	task, err = s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	task, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "failed", Message: "Native bridge stopped before turn.started", Origin: CodexBridgeFailureOrigin})
	if err != nil {
		t.Fatal(err)
	}
	return s, task
}
func retryInput(task Task) NewAttemptInput {
	return NewAttemptInput{RunID: task.RunID, FailedEventID: task.Events[len(task.Events)-1].ID, ConfirmStopped: true}
}
func persistRetryFixture(t *testing.T, s *Store, task Task) {
	t.Helper()
	b, err := json.Marshal(task)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(b), task.ID); err != nil {
		t.Fatal(err)
	}
}
func TestNewAttemptPreservesIdentityAndFailureAndAllowsOnlyOneFreshClaim(t *testing.T) {
	s, old := failedPrestart(t)
	fresh, err := s.NewAttempt(old.ID, retryInput(old))
	if err != nil {
		t.Fatal(err)
	}
	if fresh.ID != old.ID || fresh.Title != old.Title || fresh.Goal != old.Goal || fresh.Origin != old.Origin || fresh.ProjectID != old.ProjectID || fresh.ProjectName != old.ProjectName || fresh.RunID == old.RunID || fresh.Status != "not_started" || fresh.ObservedAt != "" || !reflect.DeepEqual(old.Events, fresh.Events[:len(old.Events)]) || fresh.Events[len(old.Events)].Kind != "local_retry_created" || !ValidFreshTaskBrief(fresh) {
		t.Fatal("wrong same-task transition", fresh)
	}
	if _, err = s.NewAttempt(old.ID, retryInput(old)); !errors.Is(err, ErrConflict) {
		t.Fatal("repeat retry accepted", err)
	}
	for _, action := range []string{"codex-start", "reports", "decisions", "follow-up"} {
		if _, err = s.Apply(old.ID, action, Input{RunID: old.RunID, Origin: "fixture", Kind: "failed", Message: "stale"}); !errors.Is(err, ErrConflict) {
			t.Fatal("stale old run accepted", action, err)
		}
	}
	if _, err = s.NoteCodexMissing(old.ID, old.RunID); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err = s.ObserveCodexStart(old.ID, old.RunID, startThread); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err = s.NoteCodexMissing(fresh.ID, fresh.RunID); err != nil {
		t.Fatal("new run preflight ineligible", err)
	}
	claim, err := s.Apply(fresh.ID, "codex-start", Input{RunID: fresh.RunID, Origin: "fixture", ExpectedTaskBrief: &TaskBriefExpectation{Title: fresh.Title, Goal: fresh.Goal}})
	if err != nil || claim.Status != "working" || claim.CodexLaunchNotice != nil {
		t.Fatal(err, claim)
	}
	if _, err = s.Apply(fresh.ID, "codex-start", Input{RunID: fresh.RunID, Origin: "fixture"}); !errors.Is(err, ErrConflict) {
		t.Fatal("double claimed", err)
	}
	if _, err = s.ObserveCodexStart(fresh.ID, fresh.RunID, startThread); err != nil {
		t.Fatal("new run observed start rejected", err)
	}
	ready, err := s.Apply(fresh.ID, "reports", Input{RunID: fresh.RunID, Origin: "fixture", Kind: "ready", Message: "New delivery", Evidence: []Evidence{{Label: "test", Excerpt: "PASS"}}})
	if err != nil || ready.Status != "ready" || CurrentReadyReportID(ready) == "" || !reflect.DeepEqual(old.Events, ready.Events[:len(old.Events)]) {
		t.Fatal(err, ready)
	}
}
func TestNewAttemptRejectsAnythingBeyondExactUnstartedFailureWithoutMutation(t *testing.T) {
	for _, mode := range []string{"stale-run", "stale-event", "no-stop", "synthetic", "project", "working", "ready", "unclaimed", "native-start", "launch-notice", "evidence", "binding", "decision", "command", "followup-count", "previous", "unretained", "review", "local-followup", "progress-history", "decision-history", "ready-history", "old-run-latest", "extra-failed", "no-start-event", "manual-failure-origin", "model-blocked-origin"} {
		t.Run(mode, func(t *testing.T) {
			s, task := failedPrestart(t)
			in := retryInput(task)
			switch mode {
			case "stale-run":
				in.RunID = "old-run"
			case "stale-event":
				in.FailedEventID = task.Events[0].ID
			case "no-stop":
				in.ConfirmStopped = false
			case "synthetic":
				task.Source = "synthetic"
			case "project":
				task.ProjectID = "demo"
			case "working":
				task.Status = "working"
			case "ready":
				task.Status = "ready"
			case "unclaimed":
				task.Events = append(task.Events[:1], task.Events[2])
			case "native-start":
				task.CodexStart = &CodexStartObservation{RunID: task.RunID, NativeThreadID: startThread}
			case "launch-notice":
				task.CodexLaunchNotice = &CodexLaunchNotice{Category: "missing_executable"}
			case "evidence":
				task.Evidence = []Evidence{{Excerpt: "meaningful"}}
			case "binding":
				task.CodexBinding = &CodexBinding{}
			case "decision":
				task.Decision = &Decision{Question: "Choose"}
			case "command":
				task.Commands = []Command{{RunID: task.RunID, Kind: "decision"}}
			case "followup-count":
				task.FollowUpCount = 1
			case "previous":
				task.PreviousDeliveryEvidence = &PreviousDeliveryEvidence{}
			case "unretained":
				task.PreviousEvidenceUnretained = &PreviousEvidenceUnretained{}
			case "review":
				task.DeliveryReview = &DeliveryReview{}
			case "local-followup":
				task.LocalFollowUp = &LocalFollowUp{}
			case "progress-history", "decision-history", "ready-history":
				kind := map[string]string{"progress-history": "reports:progress", "decision-history": "reports:needs_decision", "ready-history": "reports:ready"}[mode]
				task.Events = append([]Event{{Kind: kind, RunID: "older"}}, task.Events...)
			case "old-run-latest":
				task.Events = append(task.Events, Event{ID: "old-event", Kind: "reports:failed", RunID: "older"})
			case "extra-failed":
				task.Events = append(task.Events, Event{ID: "another-fail", Kind: "reports:failed", RunID: task.RunID})
				in.FailedEventID = "another-fail"
			case "no-start-event":
				task.Events[0].Kind = "other-created"
			case "manual-failure-origin":
				task.Events[2].Origin = "manual report"
			case "model-blocked-origin":
				task.Events[2].Origin = "Codex CLI native thread " + startThread + "; model-declared blocked diagnosis and evidence, not independent verification"
			}
			persistRetryFixture(t, s, task)
			before, _ := s.Get(task.ID)
			if _, err := s.NewAttempt(task.ID, in); err == nil {
				t.Fatal("unsafe retry accepted", mode)
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rejection mutated task", mode)
			}
		})
	}
}
func TestNewAttemptRaceAndRepeatedSafeFailures(t *testing.T) {
	s, old := failedPrestart(t)
	const n = 12
	var wg sync.WaitGroup
	results := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, err := s.NewAttempt(old.ID, retryInput(old)); results <- err }()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else if !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
	}
	if success != 1 {
		t.Fatal("not one retry", success)
	}
	fresh, _ := s.Get(old.ID)
	seen := map[string]bool{old.RunID: true, fresh.RunID: true}
	for i := 0; i < 3; i++ {
		if !ValidFreshTaskBrief(fresh) {
			t.Fatal("retry history broke fresh eligibility")
		}
		claimed, err := s.Apply(fresh.ID, "codex-start", Input{RunID: fresh.RunID, Origin: "fixture"})
		if err != nil {
			t.Fatal(err)
		}
		failed, err := s.Apply(claimed.ID, "reports", Input{RunID: claimed.RunID, Origin: CodexBridgeFailureOrigin, Kind: "failed", Message: "Stopped before start"})
		if err != nil {
			t.Fatal(err)
		}
		fresh, err = s.NewAttempt(failed.ID, retryInput(failed))
		if err != nil || seen[fresh.RunID] {
			t.Fatal(err, fresh.RunID)
		}
		seen[fresh.RunID] = true
	}
}
func TestNewAttemptNewRunAcceptsFirstBoundDecision(t *testing.T) {
	s, old := failedPrestart(t)
	fresh, err := s.NewAttempt(old.ID, retryInput(old))
	if err != nil {
		t.Fatal(err)
	}
	claim, err := s.Apply(fresh.ID, "codex-start", Input{RunID: fresh.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	decision := &Decision{Question: "Scope?", Options: []string{"A", "B"}}
	binding := &CodexBinding{Version: 1, TaskID: claim.ID, RunID: claim.RunID, NativeThreadID: startThread, Question: decision.Question, Options: decision.Options, CWDFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Sandbox: "read-only"}
	got, err := s.Apply(claim.ID, "reports", Input{RunID: claim.RunID, Kind: "needs_decision", Message: "Choose", Origin: "fixture", Decision: decision, CodexBinding: binding})
	if err != nil || got.Status != "needs_decision" || !SameCodexBinding(got.CodexBinding, binding) {
		t.Fatal(err, got)
	}
}
func TestNewAttemptReadbackCapRejectsAtomically(t *testing.T) {
	s, task := failedPrestart(t)
	// Saved historical failure is below the cap; the appended event would exceed it.
	task.Events[2].Message = ""
	b, _ := json.Marshal(task)

	// ASCII text avoids JSON escaping and makes the boundary deterministic.
	padding := maxTaskReadbackBytes - len(b) - 1 - 32
	task.Events[2].Message = strings.Repeat("x", padding)
	persistRetryFixture(t, s, task)
	before, _ := s.Get(task.ID)
	if _, err := s.NewAttempt(task.ID, retryInput(task)); err == nil {
		t.Fatal("oversized retry accepted")
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("size rejection changed history")
	}
}
