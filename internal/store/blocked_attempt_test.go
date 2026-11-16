package store

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func nativeBlockedOrigin(nativeID string) string {
	return "Codex CLI native thread " + nativeID + "; model-declared blocked diagnosis and evidence, not independent verification"
}

func nativeBlocked(t *testing.T, s *Store, task Task, evidence []Evidence) Task {
	t.Helper()
	claim, err := s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ObserveCodexStart(task.ID, task.RunID, startThread); err != nil {
		t.Fatal(err)
	}
	for i := range evidence {
		evidence[i].Origin = nativeBlockedOrigin(startThread)
	}
	blocked, err := s.Apply(claim.ID, "reports", Input{RunID: claim.RunID, Kind: "failed", Message: "Required checks could not run; objective incomplete", Origin: nativeBlockedOrigin(startThread), Evidence: evidence})
	if err != nil {
		t.Fatal(err)
	}
	return blocked
}

func failedNativeFixture(t *testing.T, evidence []Evidence) (*Store, Task) {
	t.Helper()
	s, task := failedPrestart(t)
	fresh, err := s.NewAttempt(task.ID, retryInput(task))
	if err != nil {
		t.Fatal(err)
	}
	return s, nativeBlocked(t, s, fresh, evidence)
}

func TestNativeBlockedNewAttemptPreservesExactFullSnapshotAndFreshClaim(t *testing.T) {
	items := make([]Evidence, 8)
	for i := range items {
		items[i] = Evidence{Label: "actual diagnostic", Excerpt: strings.Repeat("诊", 2000)}
	}
	s, old := failedNativeFixture(t, items)
	if RetryableFailedEventID(old) != old.Events[len(old.Events)-1].ID {
		t.Fatal("native blocked first turn not eligible")
	}
	fresh, err := s.NewAttempt(old.ID, retryInput(old))
	if err != nil {
		t.Fatal(err)
	}
	want := PreviousBlockedAttempt{RunID: old.RunID, ReportEventID: retryInput(old).FailedEventID, CodexStart: *old.CodexStart, Evidence: old.Evidence}
	if len(fresh.PreviousBlockedAttempts) != 1 || !reflect.DeepEqual(fresh.PreviousBlockedAttempts[0], want) {
		t.Fatal("diagnosis was truncated or changed", fresh.PreviousBlockedAttempts)
	}
	if fresh.CodexStart != nil || len(fresh.Evidence) != 0 || fresh.RunID == old.RunID || !ValidFreshTaskBrief(fresh) || !reflect.DeepEqual(old.Events, fresh.Events[:len(old.Events)]) {
		t.Fatal("not an untouched same-card new run", fresh)
	}
	saved, err := s.Get(old.ID)
	if err != nil || !reflect.DeepEqual(fresh, saved) {
		t.Fatal("snapshot not persisted exactly", err)
	}
	if _, err = s.NewAttempt(old.ID, retryInput(old)); !errors.Is(err, ErrConflict) {
		t.Fatal("stale retry accepted", err)
	}
	if _, err = s.Apply(old.ID, "reports", Input{RunID: old.RunID, Kind: "failed", Origin: "fixture", Message: "late old report"}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale run accepted", err)
	}
	claim, err := s.Apply(fresh.ID, "codex-start", Input{RunID: fresh.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal("new claim rejected", err)
	}
	ready, err := s.Apply(claim.ID, "reports", Input{RunID: claim.RunID, Kind: "ready", Origin: "fixture", Message: "Fresh delivery", Evidence: []Evidence{{Label: "check", Excerpt: "PASS"}}})
	if err != nil || !reflect.DeepEqual(ready.PreviousBlockedAttempts, fresh.PreviousBlockedAttempts) || reflect.DeepEqual(ready.Evidence, old.Evidence) {
		t.Fatal("new report altered or merged old diagnosis", err)
	}
}

func TestNativeBlockedNewAttemptRejectsUnverifiedOrNonFirstTurnWithoutMutation(t *testing.T) {
	for _, mode := range []string{"no-start", "invalid-native", "wrong-start-run", "no-start-date", "future-start", "wrong-origin", "bridge-failure", "wrong-native-origin", "stale-summary", "stale-observed", "no-report-date", "wrong-run", "stale-event", "no-stop", "working", "synthetic", "decision", "binding", "command", "receipt-history", "decision-history", "progress-history", "ready-history", "review", "follow-up", "previous-ready", "previous-unretained", "launch-notice", "evidence-origin", "evidence-url", "duplicate-archive"} {
		t.Run(mode, func(t *testing.T) {
			s, task := failedNativeFixture(t, []Evidence{{Label: "actual diagnostic", Excerpt: "Setup failed"}})
			in := retryInput(task)
			switch mode {
			case "no-start":
				task.CodexStart = nil
			case "invalid-native":
				task.CodexStart.NativeThreadID = "invalid"
			case "wrong-start-run":
				task.CodexStart.RunID = "older"
			case "no-start-date":
				task.CodexStart.ObservedAt = ""
			case "future-start":
				task.CodexStart.ObservedAt = "2099-01-01T00:00:00Z"
			case "wrong-origin":
				task.Events[len(task.Events)-1].Origin = "manual report"
			case "bridge-failure":
				task.Events[len(task.Events)-1].Origin = CodexBridgeFailureOrigin
			case "wrong-native-origin":
				task.Events[len(task.Events)-1].Origin = nativeBlockedOrigin("ffffffff-ffff-ffff-ffff-ffffffffffff")
			case "stale-summary":
				task.Summary = "different summary"
			case "stale-observed":
				task.ObservedAt = ""
			case "no-report-date":
				task.Events[len(task.Events)-1].CreatedAt = ""
			case "wrong-run":
				in.RunID = "older"
			case "stale-event":
				in.FailedEventID = task.Events[0].ID
			case "no-stop":
				in.ConfirmStopped = false
			case "working":
				task.Status = "working"
			case "synthetic":
				task.Source = "synthetic"
			case "decision":
				task.Decision = &Decision{Question: "Choose", Options: []string{"A", "B"}}
			case "binding":
				task.CodexBinding = &CodexBinding{}
			case "command":
				task.Commands = []Command{{RunID: task.RunID, Kind: "decision", Status: "acknowledged"}}
			case "receipt-history", "decision-history", "progress-history", "ready-history":
				kind := map[string]string{"receipt-history": "reports:receipt", "decision-history": "reports:needs_decision", "progress-history": "reports:progress", "ready-history": "reports:ready"}[mode]
				task.Events = append([]Event{{ID: "prior", RunID: task.RunID, Kind: kind}}, task.Events...)
			case "review":
				task.DeliveryReview = &DeliveryReview{}
			case "follow-up":
				task.LocalFollowUp = &LocalFollowUp{}
			case "previous-ready":
				task.PreviousDeliveryEvidence = &PreviousDeliveryEvidence{}
			case "previous-unretained":
				task.PreviousEvidenceUnretained = &PreviousEvidenceUnretained{}
			case "launch-notice":
				task.CodexLaunchNotice = &CodexLaunchNotice{}
			case "evidence-origin":
				task.Evidence[0].Origin = "unrelated"
			case "evidence-url":
				task.Evidence[0].URL = "https://example.org/"
			case "duplicate-archive":
				task.PreviousBlockedAttempts = []PreviousBlockedAttempt{{RunID: task.RunID}}
			}
			persistRetryFixture(t, s, task)
			before, _ := s.Get(task.ID)
			if _, err := s.NewAttempt(task.ID, in); err == nil {
				t.Fatal("unsafe native retry accepted", mode)
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rejection mutated current or history", mode)
			}
		})
	}
}

func TestNativeBlockedNewAttemptRaceAndRepeatedSnapshots(t *testing.T) {
	s, old := failedNativeFixture(t, []Evidence{})
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
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
		t.Fatal("expected exactly one new run", success)
	}
	fresh, _ := s.Get(old.ID)
	first := fresh.PreviousBlockedAttempts[0]
	second := nativeBlocked(t, s, fresh, []Evidence{{Label: "second", Excerpt: "A different actual failure"}})
	fresh, err := s.NewAttempt(second.ID, retryInput(second))
	if err != nil || len(fresh.PreviousBlockedAttempts) != 2 || !reflect.DeepEqual(first, fresh.PreviousBlockedAttempts[0]) || fresh.PreviousBlockedAttempts[1].RunID != second.RunID {
		t.Fatal("snapshot overwritten or lost", err)
	}
	// A subsequent pre-start failure still uses the unchanged original path.
	claim, err := s.Apply(fresh.ID, "codex-start", Input{RunID: fresh.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	failure, err := s.Apply(claim.ID, "reports", Input{RunID: claim.RunID, Kind: "failed", Origin: CodexBridgeFailureOrigin, Message: "Stopped before native start"})
	if err != nil {
		t.Fatal(err)
	}
	after, err := s.NewAttempt(failure.ID, retryInput(failure))
	if err != nil || !reflect.DeepEqual(after.PreviousBlockedAttempts, fresh.PreviousBlockedAttempts) {
		t.Fatal("pre-start retry changed existing archive", err)
	}
}

func TestNativeBlockedNewAttemptSizeCapIsAtomicAndArchiveNeverDropped(t *testing.T) {
	s, old := failedNativeFixture(t, []Evidence{{Label: "whole evidence", Excerpt: strings.Repeat("x", 2000)}})
	data, _ := json.Marshal(old)
	old.Events[0].Message += strings.Repeat("x", maxTaskReadbackBytes-len(data)-201)
	persistRetryFixture(t, s, old)
	before, _ := s.Get(old.ID)
	if _, err := s.NewAttempt(old.ID, retryInput(old)); err == nil || !strings.Contains(err.Error(), "1 MiB readback limit") {
		t.Fatal("archive overflow should reject", err)
	}
	after, _ := s.Get(old.ID)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("overflow discarded history or reset run")
	}

	s2, old2 := failedNativeFixture(t, []Evidence{{Label: "whole evidence", Excerpt: strings.Repeat("x", 2000)}})
	fresh, err := s2.NewAttempt(old2.ID, retryInput(old2))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s2.Apply(fresh.ID, "reports", Input{RunID: fresh.RunID, Kind: "progress", Message: strings.Repeat("x", 600000), Origin: "fixture"}); err == nil {
		t.Fatal("oversized future report accepted")
	}
	saved, _ := s2.Get(fresh.ID)
	if !reflect.DeepEqual(saved, fresh) {
		t.Fatal("future size check dropped archived evidence")
	}
}
