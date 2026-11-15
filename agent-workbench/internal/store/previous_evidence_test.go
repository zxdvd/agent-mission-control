package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func nextEvidenceReport(t *testing.T, s *Store, task Task, label string, entries []Evidence) Task {
	t.Helper()
	saved, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Report " + label, Origin: "Reporter " + label, Evidence: entries})
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestPreviousEvidenceTwoThenThreeReadyReportsKeepOnlyImmediatePrior(t *testing.T) {
	s, task, path := readyReviewFixture(t)
	first := nextEvidenceReport(t, s, task, "first", []Evidence{{Label: "Source 1", Excerpt: "Source fixture one", Origin: "Declared source A"}, {Label: "Source 2", Excerpt: "Source fixture two"}, {Label: "Source 3", Excerpt: "Source fixture three"}, {Label: "Source 4", Excerpt: "Source fixture four"}})
	firstID := CurrentReadyReportID(first)
	second := nextEvidenceReport(t, s, first, "second", []Evidence{{Label: "Correction", Excerpt: "Measured corrected fixture"}})
	previous := second.PreviousDeliveryEvidence
	if previous == nil || previous.RunID != task.RunID || previous.ReportEventID != firstID || previous.ReportedAt != first.Events[len(first.Events)-1].CreatedAt || previous.Origin != "Reporter first" || previous.Summary != first.Summary || previous.TotalCount != 4 || !reflect.DeepEqual(previous.Evidence, first.Evidence) {
		t.Fatal("previous four-source snapshot not preserved")
	}
	if second.Status != "ready" || len(second.Evidence) != 1 || second.Evidence[0].Label != "Correction" {
		t.Fatal("history merged into current")
	}
	readOnly, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer readOnly.Close()
	reload, err := readOnly.Get(task.ID)
	if err != nil || !reflect.DeepEqual(second, reload) {
		t.Fatal("snapshot not durable", err)
	}
	third := nextEvidenceReport(t, s, second, "third", []Evidence{{Excerpt: "Third current result"}})
	if third.PreviousDeliveryEvidence == nil || third.PreviousDeliveryEvidence.ReportEventID != CurrentReadyReportID(second) || !reflect.DeepEqual(third.PreviousDeliveryEvidence.Evidence, second.Evidence) || third.PreviousDeliveryEvidence.TotalCount != 1 {
		t.Fatal("third report did not retain only second")
	}
	if !reflect.DeepEqual(previous.Evidence, first.Evidence) {
		t.Fatal("earlier stable snapshot mutated")
	}
}

func TestPreviousEvidenceBoundsCountSummaryAndBytes(t *testing.T) {
	for _, mode := range []string{"count", "bytes"} {
		t.Run(mode, func(t *testing.T) {
			s, task, _ := readyReviewFixture(t)
			entries := []Evidence{}
			count := 12
			excerpt := "Bounded fixture"
			if mode == "bytes" {
				count = 8
				excerpt = strings.Repeat("🙂", 2000)
			}
			for i := 0; i < count; i++ {
				entries = append(entries, Evidence{Label: fmt.Sprintf("Entry %d", i), Excerpt: excerpt, Origin: "Declared fixture"})
			}
			old, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: strings.Repeat("摘", 700), Origin: "fixture", Evidence: entries})
			if err != nil {
				t.Fatal(err)
			}
			saved := nextEvidenceReport(t, s, old, "new", []Evidence{{Excerpt: "New current result"}})
			prior := saved.PreviousDeliveryEvidence
			if prior == nil {
				t.Fatal("missing bounded snapshot")
			}
			encoded, _ := json.Marshal(prior)
			if len(prior.Evidence) > 8 || len(encoded) > maxPreviousEvidenceBytes || prior.TotalCount != count || len([]rune(prior.Summary)) != 500 || !prior.SummaryTruncated {
				t.Fatal("snapshot bound exceeded")
			}
			if mode == "count" && len(prior.Evidence) != 8 {
				t.Fatal("count cap not applied")
			}
			if mode == "bytes" && len(prior.Evidence) >= count {
				t.Fatal("byte cap not applied")
			}
			if !reflect.DeepEqual(prior.Evidence, entries[:len(prior.Evidence)]) {
				t.Fatal("entries were altered, not retained as complete prefix")
			}
		})
	}
}

func TestPreviousEvidenceNeverMakesReadbackExceedExistingBound(t *testing.T) {
	s, task, _ := readyReviewFixture(t)
	entries := []Evidence{{Excerpt: strings.Repeat("a", 2000)}, {Excerpt: strings.Repeat("b", 2000)}, {Excerpt: strings.Repeat("c", 2000)}, {Excerpt: strings.Repeat("d", 2000)}}
	old := nextEvidenceReport(t, s, task, "large", entries)
	old.PreviousDeliveryEvidence = nil
	encoded, _ := json.Marshal(old)
	old.Events = append(old.Events, Event{ID: "padding-fixture", RunID: old.RunID, Kind: "fixture", Message: strings.Repeat("x", maxTaskReadbackBytes-len(encoded)-2048)})
	encoded, _ = json.Marshal(old)
	if len(encoded)+1 >= maxTaskReadbackBytes {
		t.Fatal("fixture itself exceeds existing readback bound")
	}
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), old.ID); err != nil {
		t.Fatal(err)
	}
	saved := nextEvidenceReport(t, s, old, "next", entries)
	encoded, _ = json.Marshal(saved)
	if saved.PreviousDeliveryEvidence != nil || len(encoded)+1 > maxTaskReadbackBytes || saved.Status != "ready" || !reflect.DeepEqual(saved.Evidence, entries) {
		t.Fatal("optional history exceeded headroom or blocked/altered new report")
	}
	if saved.PreviousEvidenceUnretained == nil || saved.PreviousEvidenceUnretained.Reason != "task_size_limit" || saved.PreviousEvidenceUnretained.RunID != saved.RunID || saved.PreviousEvidenceUnretained.ReportEventID != CurrentReadyReportID(old) {
		t.Fatal("size omission was silent despite marker headroom")
	}
	// A later successful snapshot clears the old omission reason.
	compact := saved
	compact.Events = nil
	for _, event := range saved.Events {
		if event.ID != "padding-fixture" {
			compact.Events = append(compact.Events, event)
		}
	}
	encoded, _ = json.Marshal(compact)
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), saved.ID); err != nil {
		t.Fatal(err)
	}
	next := nextEvidenceReport(t, s, compact, "compact", []Evidence{{Excerpt: "Small new report"}})
	if next.PreviousDeliveryEvidence == nil || next.PreviousEvidenceUnretained != nil {
		t.Fatal("successful snapshot retained stale omission reason")
	}
	// Explicit clearing removes even a reason-only marker, not just snapshots.
	next.PreviousEvidenceUnretained = saved.PreviousEvidenceUnretained
	next.PreviousDeliveryEvidence = nil
	encoded, _ = json.Marshal(next)
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), next.ID); err != nil {
		t.Fatal(err)
	}
	cleared, err := s.Apply(next.ID, "reports", Input{RunID: next.RunID, Kind: "ready", Message: "Explicit clearing", Origin: "fixture", Evidence: []Evidence{}})
	if err != nil || cleared.PreviousEvidenceUnretained != nil || cleared.PreviousDeliveryEvidence != nil {
		t.Fatal("explicit clearing retained optional reason", err)
	}

}

func TestPreviousEvidenceReceiptEmptyFailureAndRunGuards(t *testing.T) {
	s, task, _ := readyReviewFixture(t)
	second := nextEvidenceReport(t, s, task, "second", []Evidence{{Excerpt: "Second result"}})
	before := second.PreviousDeliveryEvidence
	if before == nil {
		t.Fatal("no fixture history")
	}
	// A real saved receipt on ready is bookkeeping, not a replacement delivery.
	second.Commands = append(second.Commands, Command{ID: "receipt-fixture", RunID: second.RunID, Kind: "follow_up", Status: "recorded"})
	data, _ := json.Marshal(second)
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), second.ID); err != nil {
		t.Fatal(err)
	}
	receipt, err := s.Apply(second.ID, "reports", Input{RunID: second.RunID, Kind: "receipt", CommandID: "receipt-fixture", Origin: "fixture"})
	if err != nil || !reflect.DeepEqual(before, receipt.PreviousDeliveryEvidence) {
		t.Fatal("receipt replaced historical evidence", err)
	}
	third := nextEvidenceReport(t, s, receipt, "third", []Evidence{{Excerpt: "Third result"}})
	if third.PreviousDeliveryEvidence.ReportEventID != CurrentReadyReportID(second) {
		t.Fatal("receipt hid prior exact ready report")
	}
	if _, err = s.Apply(task.ID, "reports", Input{RunID: "old-run", Kind: "ready", Message: "Rejected", Origin: "fixture", Evidence: []Evidence{{Excerpt: "Rejected"}}}); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(third, after) {
		t.Fatal("old run mutated snapshot")
	}
	// Empty ready must not borrow historical evidence to look ready or reviewed.
	empty, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Explicit empty", Origin: "fixture", Evidence: []Evidence{}})
	if err != nil || empty.Status != "needs_evidence" || len(empty.Evidence) != 0 || empty.PreviousDeliveryEvidence != nil {
		t.Fatal("explicit clearing retained or promoted optional history", err)
	}
	fresh := nextEvidenceReport(t, s, empty, "after-empty", []Evidence{{Excerpt: "Fresh result"}})
	if fresh.PreviousDeliveryEvidence != nil {
		t.Fatal("empty path fabricated old current evidence")
	}
	failed, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "failed", Message: "Stopped", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	recovered := nextEvidenceReport(t, s, failed, "recovered", []Evidence{{Excerpt: "Recovery result"}})
	if recovered.PreviousDeliveryEvidence != nil {
		t.Fatal("non-ready path fabricated previous ready snapshot")
	}
}

func TestPreviousEvidenceDoesNotCopyOtherRunOrDemoAndRejectedWriteIsUnchanged(t *testing.T) {
	for _, mode := range []string{"other-run", "demo", "invalid-new"} {
		t.Run(mode, func(t *testing.T) {
			s, task, _ := readyReviewFixture(t)
			switch mode {
			case "other-run":
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.run_id','new-run') WHERE id=?`, task.ID)
			case "demo":
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.source','synthetic','$.project_id','demo') WHERE id=?`, task.ID)
			}
			before, _ := s.Get(task.ID)
			excerpt := "New current result"
			if mode == "invalid-new" {
				excerpt = strings.Repeat("x", 2001)
			}
			saved, err := s.Apply(task.ID, "reports", Input{RunID: before.RunID, Kind: "ready", Message: "Replacement", Origin: "fixture", Evidence: []Evidence{{Excerpt: excerpt}}})
			if mode == "invalid-new" {
				after, _ := s.Get(task.ID)
				if err == nil || !reflect.DeepEqual(before, after) {
					t.Fatal("rejected report mutated history")
				}
				return
			}
			if err != nil || saved.PreviousDeliveryEvidence != nil {
				t.Fatal("copied other-run or synthetic evidence", err)
			}
		})
	}
}

func TestPreviousEvidenceUnretainedReasonItselfIsOptionalUnderCap(t *testing.T) {
	for _, headroom := range []int{1, 1000} {
		task := Task{ID: "fixture", RunID: "run", Summary: ""}
		base, _ := json.Marshal(task)
		task.Summary = strings.Repeat("x", maxTaskReadbackBytes-len(base)-1-headroom)
		task.PreviousDeliveryEvidence = &PreviousDeliveryEvidence{RunID: "run", ReportEventID: "old-ready", Evidence: []Evidence{{Excerpt: strings.Repeat("e", 2000)}}, TotalCount: 1}
		data, err := marshalTask(&task)
		if err != nil || len(data)+1 > maxTaskReadbackBytes || task.PreviousDeliveryEvidence != nil {
			t.Fatal("optional marker worsened cap", err)
		}
		if (headroom == 1000) != (task.PreviousEvidenceUnretained != nil) {
			t.Fatal("omission marker did not obey its own budget")
		}
	}
}
