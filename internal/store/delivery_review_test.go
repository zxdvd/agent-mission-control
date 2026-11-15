package store

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func readyReviewFixture(t *testing.T) (*Store, Task, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "review.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	task, err := s.Create(CreateInput{Title: "Delivery fixture", Goal: "Human seen marker only", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	task, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Declared delivery", Origin: "fixture", Evidence: []Evidence{{Label: "Fixture evidence", Excerpt: "A reported result, not independent verification"}}})
	if err != nil {
		t.Fatal(err)
	}
	return s, task, path
}

func TestDeliveryReviewIsDurableIdempotentAndNotCompletion(t *testing.T) {
	s, task, path := readyReviewFixture(t)
	reportID := CurrentReadyReportID(task)
	if reportID == "" {
		t.Fatal("no current ready report")
	}
	saved, err := s.ReviewDelivery(task.ID, task.RunID, reportID)
	if err != nil || saved.DeliveryReview == nil || saved.DeliveryReview.RunID != task.RunID || saved.DeliveryReview.ReportEventID != reportID {
		t.Fatal(err, saved)
	}
	if _, err = time.Parse(time.RFC3339Nano, saved.DeliveryReview.ReviewedAt); err != nil {
		t.Fatal(err)
	}
	without := saved
	without.DeliveryReview = nil
	if !reflect.DeepEqual(task, without) {
		t.Fatal("seen marker changed lifecycle/evidence/history", task, saved)
	}
	duplicate, err := s.ReviewDelivery(task.ID, task.RunID, reportID)
	if err != nil || !reflect.DeepEqual(saved, duplicate) {
		t.Fatal("duplicate refreshed date or changed state", err, duplicate)
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reload, err := reopened.Get(task.ID)
	if err != nil || !reflect.DeepEqual(saved, reload) || reload.Status != "ready" {
		t.Fatal("reload lost marker or completed task", err, reload)
	}
}

func TestDeliveryReviewNewReportReturnsToReviewAndOldPageCannotHideIt(t *testing.T) {
	s, task, _ := readyReviewFixture(t)
	firstID := CurrentReadyReportID(task)
	viewed, err := s.ReviewDelivery(task.ID, task.RunID, firstID)
	if err != nil {
		t.Fatal(err)
	}
	// Even identical text/evidence is a new formal report with a different token.
	newer, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: task.Summary, Origin: "fixture", Evidence: task.Evidence})
	if err != nil {
		t.Fatal(err)
	}
	secondID := CurrentReadyReportID(newer)
	if secondID == firstID || newer.DeliveryReview == nil || newer.DeliveryReview.ReportEventID != firstID {
		t.Fatal(newer)
	}
	for _, tc := range []struct{ run, report string }{{task.RunID, firstID}, {"stale-run", secondID}, {task.RunID, ""}, {task.RunID, "unknown-event"}} {
		if _, err = s.ReviewDelivery(task.ID, tc.run, tc.report); !errors.Is(err, ErrConflict) {
			t.Fatal("stale review accepted", err)
		}
		after, _ := s.Get(task.ID)
		if !reflect.DeepEqual(newer, after) {
			t.Fatal("stale page hid newer report", after)
		}
	}
	second, err := s.ReviewDelivery(task.ID, task.RunID, secondID)
	if err != nil || second.DeliveryReview.ReportEventID != secondID {
		t.Fatal(err, second)
	}
	changed, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Changed evidence", Origin: "fixture", Evidence: []Evidence{{Label: "New report", Excerpt: "Changed evidence must remain visible"}}})
	if err != nil {
		t.Fatal(err)
	}
	if CurrentReadyReportID(changed) == second.DeliveryReview.ReportEventID || changed.Evidence[0].Excerpt == viewed.Evidence[0].Excerpt {
		t.Fatal(changed)
	}
	if _, err = s.ReviewDelivery(task.ID, task.RunID, secondID); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(changed, after) {
		t.Fatal("old repeat dirtied changed evidence", after)
	}
}

func TestDeliveryReviewRejectsNonReviewableWork(t *testing.T) {
	for _, mode := range []string{"not_started", "working", "needs_decision", "needs_evidence", "blocked", "done", "synthetic", "demo", "no-evidence", "no-ready-event", "wrong-run-event"} {
		t.Run(mode, func(t *testing.T) {
			s, task, _ := readyReviewFixture(t)
			reportID := CurrentReadyReportID(task)
			switch mode {
			case "synthetic":
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.source','synthetic') WHERE id=?`, task.ID)
			case "demo":
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.project_id','demo') WHERE id=?`, task.ID)
			case "no-evidence":
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.evidence',json('[]')) WHERE id=?`, task.ID)
			case "no-ready-event":
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.events[1].kind','reports:progress') WHERE id=?`, task.ID)
			case "wrong-run-event":
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.events[1].run_id','other-run') WHERE id=?`, task.ID)
			default:
				_, _ = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.status',?) WHERE id=?`, mode, task.ID)
			}
			before, err := s.Get(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			if CurrentReadyReportID(before) != "" {
				t.Fatal("invalid ready token", before)
			}
			if _, err = s.ReviewDelivery(task.ID, task.RunID, reportID); !errors.Is(err, ErrConflict) {
				t.Fatal("nonreviewable work accepted", err)
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rejected review mutated task", after)
			}
		})
	}
}
