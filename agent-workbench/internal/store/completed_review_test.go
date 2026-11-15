package store

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestCompletedClaimQueuesExactDeliveryForReviewAndLocalEnd(t *testing.T) {
	s, task, path := readyReviewFixture(t)
	completed, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "completed", Message: "Reporter claims completion", Origin: "fixture", Evidence: []Evidence{{Excerpt: "New supplied result"}}})
	if err != nil {
		t.Fatal(err)
	}
	event := completed.Events[len(completed.Events)-1]
	if completed.Status != "ready" || completed.Decision != nil || event.Kind != "reports:completed" || CurrentReadyReportID(completed) != event.ID {
		t.Fatal("completed bypassed review or lost exact event")
	}
	if _, err = s.SetLocalFollowUp(task.ID, task.RunID, event.ID, "end", ""); !errors.Is(err, ErrConflict) {
		t.Fatal("unread completed claim ended", err)
	}
	viewed, err := s.ReviewDelivery(task.ID, task.RunID, event.ID)
	if err != nil {
		t.Fatal(err)
	}
	without := viewed
	without.DeliveryReview = nil
	if !reflect.DeepEqual(completed, without) {
		t.Fatal("view mutated delivery")
	}
	ended, err := s.SetLocalFollowUp(task.ID, task.RunID, event.ID, "end", "")
	if err != nil {
		t.Fatal(err)
	}
	without = ended
	without.LocalFollowUp = nil
	if !reflect.DeepEqual(viewed, without) || ended.Status != "ready" {
		t.Fatal("local end accepted or changed delivery")
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reload, err := reopened.Get(task.ID)
	if err != nil || !reflect.DeepEqual(ended, reload) {
		t.Fatal("reload changed completed review", err)
	}
}

func TestEitherDeliveryKindReplacesExactReviewAndPreviousEvidence(t *testing.T) {
	for _, priorKind := range []string{"ready", "completed"} {
		for _, nextKind := range []string{"ready", "completed"} {
			t.Run(priorKind+"-to-"+nextKind, func(t *testing.T) {
				s, task, _ := readyReviewFixture(t)
				prior, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: priorKind, Message: "Prior delivery", Origin: "prior fixture", Evidence: []Evidence{{Excerpt: "Prior result"}}})
				if err != nil {
					t.Fatal(err)
				}
				priorID := CurrentReadyReportID(prior)
				if _, err = s.ReviewDelivery(task.ID, task.RunID, priorID); err != nil {
					t.Fatal(err)
				}
				ended, err := s.SetLocalFollowUp(task.ID, task.RunID, priorID, "end", "")
				if err != nil {
					t.Fatal(err)
				}
				next, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: nextKind, Message: "Replacement delivery", Origin: "next fixture", Evidence: []Evidence{{Excerpt: "New result"}}})
				if err != nil {
					t.Fatal(err)
				}
				nextID := CurrentReadyReportID(next)
				if nextID == "" || nextID == priorID || next.Status != "ready" || next.Events[len(next.Events)-1].Kind != "reports:"+nextKind {
					t.Fatal("replacement lost exact report")
				}
				snapshot := next.PreviousDeliveryEvidence
				if snapshot == nil || snapshot.ReportEventID != priorID || snapshot.RunID != prior.RunID || snapshot.ReportedAt != prior.Events[len(prior.Events)-1].CreatedAt || snapshot.Origin != "prior fixture" || snapshot.Summary != prior.Summary || !reflect.DeepEqual(snapshot.Evidence, prior.Evidence) {
					t.Fatal("previous delivery lost or mixed")
				}
				if !reflect.DeepEqual(next.DeliveryReview, ended.DeliveryReview) || !reflect.DeepEqual(next.LocalFollowUp, ended.LocalFollowUp) {
					t.Fatal("replacement rewrote old markers")
				}
				if _, err = s.ReviewDelivery(task.ID, task.RunID, priorID); !errors.Is(err, ErrConflict) {
					t.Fatal("stale review accepted", err)
				}
				if _, err = s.SetLocalFollowUp(task.ID, task.RunID, priorID, "resume", ended.LocalFollowUp.RecordedAt); !errors.Is(err, ErrConflict) {
					t.Fatal("stale restore accepted", err)
				}
				if _, err = s.SetLocalFollowUp(task.ID, task.RunID, nextID, "end", ""); !errors.Is(err, ErrConflict) {
					t.Fatal("old view covered new delivery", err)
				}
				after, _ := s.Get(task.ID)
				if !reflect.DeepEqual(next, after) {
					t.Fatal("stale operation dirtied replacement")
				}
				if _, err = s.ReviewDelivery(task.ID, task.RunID, nextID); err != nil {
					t.Fatal(err)
				}
				if _, err = s.SetLocalFollowUp(task.ID, task.RunID, nextID, "end", ""); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

func TestCompletedNeedsIncomingEvidenceAndDoesNotMigrateLegacyDone(t *testing.T) {
	s, task, path := readyReviewFixture(t)
	for _, evidence := range [][]Evidence{nil, {}, {{Label: "No result"}}} {
		if _, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "completed", Message: "No new evidence", Origin: "fixture", Evidence: evidence}); err == nil {
			t.Fatal("borrowed existing evidence")
		}
		after, _ := s.Get(task.ID)
		if !reflect.DeepEqual(task, after) {
			t.Fatal("rejected completion mutated task")
		}
	}
	// A persisted pre-change completed/done record is historical, never migrated.
	task.Status = "done"
	task.Events[len(task.Events)-1].Kind = "reports:completed"
	data, _ := json.Marshal(task)
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), task.ID); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	legacy, err := reopened.Get(task.ID)
	if err != nil || !reflect.DeepEqual(task, legacy) || CurrentReadyReportID(legacy) != "" {
		t.Fatal("legacy done reopened", err)
	}
	id := task.Events[len(task.Events)-1].ID
	if _, err = reopened.ReviewDelivery(task.ID, task.RunID, id); !errors.Is(err, ErrConflict) {
		t.Fatal("legacy done reviewable", err)
	}
	if _, err = reopened.SetLocalFollowUp(task.ID, task.RunID, id, "end", ""); !errors.Is(err, ErrConflict) {
		t.Fatal("legacy done end allowed", err)
	}
	after, _ := reopened.Get(task.ID)
	if !reflect.DeepEqual(task, after) {
		t.Fatal("legacy done mutated")
	}
	// The alternate event alone never makes absent current evidence reviewable.
	legacy.Status = "ready"
	legacy.Evidence = nil
	if CurrentReadyReportID(legacy) != "" {
		t.Fatal("completed token without evidence")
	}
}

func TestCompletedReplacementRetainsBoundedOmissionMarker(t *testing.T) {
	s, prior, _ := readyReviewFixture(t)
	prior.PreviousDeliveryEvidence = nil
	data, _ := json.Marshal(prior)
	prior.Events = append(prior.Events, Event{ID: "padding-fixture", RunID: prior.RunID, Kind: "fixture", Message: strings.Repeat("x", maxTaskReadbackBytes-len(data)-2048)})
	data, _ = json.Marshal(prior)
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), prior.ID); err != nil {
		t.Fatal(err)
	}
	next, err := s.Apply(prior.ID, "reports", Input{RunID: prior.RunID, Kind: "completed", Message: "New result", Origin: "fixture", Evidence: []Evidence{{Excerpt: strings.Repeat("e", 1500)}}})
	if err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(next)
	if next.Status != "ready" || next.PreviousDeliveryEvidence != nil || next.PreviousEvidenceUnretained == nil || next.PreviousEvidenceUnretained.ReportEventID != CurrentReadyReportID(prior) || next.PreviousEvidenceUnretained.Reason != "task_size_limit" || len(data)+1 > maxTaskReadbackBytes {
		t.Fatal("completed replacement bypassed history readback policy")
	}
}
