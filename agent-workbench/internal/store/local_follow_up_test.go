package store

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func viewedFollowUpFixture(t *testing.T) (*Store, Task, string) {
	t.Helper()
	s, task, path := readyReviewFixture(t)
	task, err := s.ReviewDelivery(task.ID, task.RunID, CurrentReadyReportID(task))
	if err != nil {
		t.Fatal(err)
	}
	return s, task, path
}

func TestLocalFollowUpEndRestoreIsDurableReversibleAndNotCompletion(t *testing.T) {
	s, task, path := viewedFollowUpFixture(t)
	report := CurrentReadyReportID(task)
	ended, err := s.SetLocalFollowUp(task.ID, task.RunID, report, "end", "")
	if err != nil || ended.LocalFollowUp == nil || ended.LocalFollowUp.State != "ended" || ended.LocalFollowUp.RunID != task.RunID || ended.LocalFollowUp.ReportEventID != report {
		t.Fatal(err, ended)
	}
	if _, err = time.Parse(time.RFC3339Nano, ended.LocalFollowUp.RecordedAt); err != nil {
		t.Fatal(err)
	}
	without := ended
	without.LocalFollowUp = nil
	if !reflect.DeepEqual(task, without) {
		t.Fatal("end mutated lifecycle/evidence/history/review", ended)
	}
	duplicate, err := s.SetLocalFollowUp(task.ID, task.RunID, report, "end", "")
	if err != nil || !reflect.DeepEqual(ended, duplicate) {
		t.Fatal("repeat end changed timestamp", err, duplicate)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reload, err := reopened.Get(task.ID)
	if err != nil || !reflect.DeepEqual(ended, reload) {
		t.Fatal("reload lost list marker", err, reload)
	}
	restored, err := s.SetLocalFollowUp(task.ID, task.RunID, report, "resume", ended.LocalFollowUp.RecordedAt)
	if err != nil || restored.LocalFollowUp.State != "open" {
		t.Fatal(err, restored)
	}
	without = restored
	without.LocalFollowUp = nil
	if !reflect.DeepEqual(task, without) {
		t.Fatal("restore changed review/lifecycle", restored)
	}
	duplicate, err = s.SetLocalFollowUp(task.ID, task.RunID, report, "resume", ended.LocalFollowUp.RecordedAt)
	if err != nil || !reflect.DeepEqual(restored, duplicate) {
		t.Fatal("repeat resume changed timestamp", err, duplicate)
	}
	// A delayed old close must not reverse the user's newer explicit restore.
	if _, err = s.SetLocalFollowUp(task.ID, task.RunID, report, "end", ""); !errors.Is(err, ErrConflict) {
		t.Fatal("stale end reversed restore", err)
	}
	again, err := s.SetLocalFollowUp(task.ID, task.RunID, report, "end", restored.LocalFollowUp.RecordedAt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.SetLocalFollowUp(task.ID, task.RunID, report, "resume", ended.LocalFollowUp.RecordedAt); !errors.Is(err, ErrConflict) {
		t.Fatal("old resume reversed newer end", err)
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(again, after) {
		t.Fatal("stale toggle changed state", after)
	}
}

func TestLocalFollowUpNewReadyInvalidatesOldMarkerAndNeedsNewReview(t *testing.T) {
	s, task, _ := viewedFollowUpFixture(t)
	oldID := CurrentReadyReportID(task)
	ended, err := s.SetLocalFollowUp(task.ID, task.RunID, oldID, "end", "")
	if err != nil {
		t.Fatal(err)
	}
	// Receipt bookkeeping does not change evidence or invalidate the report marker.
	if _, err = s.db.Exec(`UPDATE tasks SET data=json_insert(data,'$.events[#]',json_object('id','receipt-fixture','run_id',?,'kind','reports:receipt')) WHERE id=?`, task.RunID, task.ID); err != nil {
		t.Fatal(err)
	}
	receipt, _ := s.Get(task.ID)
	if CurrentReadyReportID(receipt) != oldID || !reflect.DeepEqual(receipt.LocalFollowUp, ended.LocalFollowUp) {
		t.Fatal(receipt)
	}
	newer, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "New formal evidence", Origin: "fixture", Evidence: []Evidence{{Excerpt: "Must return to active and review"}}})
	if err != nil {
		t.Fatal(err)
	}
	newID := CurrentReadyReportID(newer)
	if newID == oldID {
		t.Fatal(newer)
	}
	for _, tc := range []struct{ run, id, op, rev string }{{task.RunID, oldID, "end", ""}, {task.RunID, oldID, "resume", ended.LocalFollowUp.RecordedAt}, {"old-run", newID, "end", ""}, {task.RunID, newID, "end", ""}} {
		if _, err = s.SetLocalFollowUp(task.ID, tc.run, tc.id, tc.op, tc.rev); !errors.Is(err, ErrConflict) {
			t.Fatal("stale or unread report accepted", err)
		}
		after, _ := s.Get(task.ID)
		if !reflect.DeepEqual(newer, after) {
			t.Fatal("stale operation dirtied new evidence", after)
		}
	}
	reviewed, err := s.ReviewDelivery(task.ID, task.RunID, newID)
	if err != nil {
		t.Fatal(err)
	}
	closedNew, err := s.SetLocalFollowUp(task.ID, task.RunID, newID, "end", "")
	if err != nil || closedNew.LocalFollowUp.ReportEventID != newID || !reflect.DeepEqual(reviewed.DeliveryReview, closedNew.DeliveryReview) {
		t.Fatal(err, closedNew)
	}
}

func TestLocalFollowUpRequiresCurrentViewedLocalReady(t *testing.T) {
	for _, mode := range []string{"unread", "wrong-review", "no-evidence", "synthetic", "demo", "working", "blocked", "done", "unknown-operation"} {
		t.Run(mode, func(t *testing.T) {
			s, task, _ := viewedFollowUpFixture(t)
			report := CurrentReadyReportID(task)
			operation := "end"
			var err error
			switch mode {
			case "unread":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_remove(data,'$.delivery_review') WHERE id=?`, task.ID)
			case "wrong-review":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.delivery_review.report_event_id','other') WHERE id=?`, task.ID)
			case "no-evidence":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.evidence',json('[]')) WHERE id=?`, task.ID)
			case "synthetic":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.source','synthetic') WHERE id=?`, task.ID)
			case "demo":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.project_id','demo') WHERE id=?`, task.ID)
			case "unknown-operation":
				operation = "complete"
			default:
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.status',?) WHERE id=?`, mode, task.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			before, _ := s.Get(task.ID)
			if _, err = s.SetLocalFollowUp(task.ID, task.RunID, report, operation, ""); err == nil {
				t.Fatal("invalid work accepted")
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("invalid operation changed state", after)
			}
		})
	}
}
