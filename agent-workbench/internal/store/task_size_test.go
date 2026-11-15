package store

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestTaskSizeReadbackBoundaryIncludesEncoderNewline(t *testing.T) {
	for _, delta := range []int{-1, 0, 1} {
		task := Task{ID: "boundary-fixture", Summary: ""}
		base, _ := json.Marshal(task)
		expectedSize := maxTaskReadbackBytes - 1 + delta
		task.Summary = strings.Repeat("x", expectedSize-len(base))
		raw, _ := json.Marshal(task)
		if len(raw) != expectedSize {
			t.Fatal("incorrect boundary fixture")
		}
		data, err := marshalTask(&task)
		if delta <= 0 {
			if err != nil || len(data)+1 > maxTaskReadbackBytes || !json.Valid(data) {
				t.Fatal("readable task rejected", delta, err)
			}
		} else if err == nil || len(data) != 0 || !strings.Contains(err.Error(), "change not saved") {
			t.Fatal("encoder newline exceeded the readback limit without rejection", err)
		}
	}
}

func TestTaskSizeOversizedReportRejectsBeforePersistingAnyMutation(t *testing.T) {
	s, task, path := readyReviewFixture(t)
	task = nextEvidenceReport(t, s, task, "second", []Evidence{{Excerpt: "Current evidence remains unchanged"}})
	var err error
	task, err = s.ReviewDelivery(task.ID, task.RunID, CurrentReadyReportID(task))
	if err != nil {
		t.Fatal(err)
	}
	task, err = s.SetLocalFollowUp(task.ID, task.RunID, CurrentReadyReportID(task), "end", "")
	if err != nil {
		t.Fatal(err)
	}
	if task.PreviousDeliveryEvidence == nil {
		t.Fatal("fixture lacks optional history")
	}
	input := Input{RunID: task.RunID, Kind: "progress", Message: strings.Repeat("x", 600000), Origin: "fixture"}
	request, _ := json.Marshal(input)
	if len(request) >= maxTaskReadbackBytes {
		t.Fatal("request fixture should fit HTTP input bound")
	}
	if _, err = s.Apply(task.ID, "reports", input); err == nil || !strings.Contains(err.Error(), "1 MiB readback limit") {
		t.Fatal("expected fixed size rejection", err)
	}
	after, err := s.Get(task.ID)
	if err != nil || !reflect.DeepEqual(task, after) {
		t.Fatal("rejected report changed state, evidence, history, review, follow-up or timestamps", err)
	}
	// Verify persistence through another connection, not just the returned error/task.
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	reload, err := reopened.Get(task.ID)
	if err != nil || !reflect.DeepEqual(task, reload) {
		t.Fatal("rejected report changed persisted task", err)
	}
}
