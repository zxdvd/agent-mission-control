package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func followUpFixture(t *testing.T) (*Store, Task, string, FollowUpInput) {
	t.Helper()
	s, task, path := viewedFollowUpFixture(t)
	task, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Exact report summary\nwith formatting", Origin: "synthetic fixture", Evidence: []Evidence{{Label: "Synthetic link", URL: "https://example.test/result?q=synthetic", Excerpt: "Exact evidence", Origin: "fixture"}}})
	if err != nil {
		t.Fatal(err)
	}
	return s, task, path, FollowUpInput{RequestID: "client-request-1", RunID: task.RunID, ReportEventID: CurrentReadyReportID(task), Kind: "explain", Message: "  Why is this evidence sufficient?\nKeep exact wording.  "}
}

func followUpTaskBytes(t *testing.T, s *Store, id string) string {
	t.Helper()
	var data string
	if err := s.db.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestFollowUpSnapshotIdempotencyAndOriginalUnchanged(t *testing.T) {
	s, task, path, in := followUpFixture(t)
	before := followUpTaskBytes(t, s, task.ID)
	f, err := s.SubmitFollowUp(task.ID, in)
	if err != nil || f.State != "pending" || f.Message != in.Message || f.ClaimID != "" {
		t.Fatal(f, err)
	}
	if f.Snapshot.Title != task.Title || f.Snapshot.Goal != task.Goal || f.Snapshot.Report.Message != task.Summary || f.Snapshot.Report.ID != in.ReportEventID || !reflect.DeepEqual(f.Snapshot.Evidence, task.Evidence) {
		t.Fatal("inexact snapshot", f)
	}
	again, err := s.SubmitFollowUp(task.ID, in)
	if err != nil || !reflect.DeepEqual(f, again) {
		t.Fatal("duplicate not exact", again, err)
	}
	for _, change := range []func(*FollowUpInput){func(i *FollowUpInput) { i.Kind = "adjust" }, func(i *FollowUpInput) { i.Message = strings.TrimSpace(i.Message) }, func(i *FollowUpInput) { i.ReportEventID = "other" }, func(i *FollowUpInput) { i.RunID = "other" }} {
		different := in
		change(&different)
		if _, err = s.SubmitFollowUp(task.ID, different); !errors.Is(err, ErrConflict) {
			t.Fatal("duplicate payload changed", err)
		}
	}
	other := in
	other.RequestID = "client-request-2"
	if _, err = s.SubmitFollowUp(task.ID, other); !errors.Is(err, ErrConflict) {
		t.Fatal("accepted second active", err)
	}
	if after := followUpTaskBytes(t, s, task.ID); after != before {
		t.Fatal("submission changed original task JSON")
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	list, err := reopened.ListFollowUps(task.ID)
	if err != nil || len(list) != 1 || !reflect.DeepEqual(f, list[0]) {
		t.Fatal("roundtrip changed", list, err)
	}
	// Snapshot remains independent of later task metadata and evidence.
	newer, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "New delivery", Origin: "fixture", Evidence: []Evidence{{Excerpt: "new evidence"}}})
	if err != nil {
		t.Fatal(err)
	}
	if CurrentReadyReportID(newer) == in.ReportEventID {
		t.Fatal("bad fixture")
	}
	duplicate, err := s.SubmitFollowUp(task.ID, in)
	if err != nil || !reflect.DeepEqual(f, duplicate) {
		t.Fatal("lost-receipt retry after new report changed request", duplicate, err)
	}
}

func TestFollowUpClaimOwnerFinalizationAndRestartNoReplay(t *testing.T) {
	s, task, path, in := followUpFixture(t)
	before := followUpTaskBytes(t, s, task.ID)
	if _, err := s.SubmitFollowUp(task.ID, in); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan FollowUp, 2)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); f, e := s.ClaimFollowUp(task.ID, in.RequestID); results <- f; errs <- e }()
	}
	wg.Wait()
	close(results)
	close(errs)
	successes, conflicts := 0, 0
	var owner FollowUp
	for e := range errs {
		if e == nil {
			successes++
		} else if errors.Is(e, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(e)
		}
	}
	for f := range results {
		if f.ClaimID != "" {
			owner = f
		}
	}
	if successes != 1 || conflicts != 1 || owner.State != "running" || owner.ClaimID == "" {
		t.Fatal("claim not exclusive", successes, conflicts, owner)
	}
	encoded, _ := json.Marshal(owner)
	if strings.Contains(string(encoded), owner.ClaimID) || strings.Contains(string(encoded), "claim_id") {
		t.Fatal("claim leaked through JSON", string(encoded))
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if _, err = reopened.ClaimFollowUp(task.ID, in.RequestID); !errors.Is(err, ErrConflict) {
		t.Fatal("restart replayed running request", err)
	}
	listed, err := reopened.ListFollowUps(task.ID)
	if err != nil || len(listed) != 1 || listed[0].State != "running" || listed[0].ClaimID != "" {
		t.Fatal("list leaked owner or reset state", listed, err)
	}
	duplicate, err := reopened.SubmitFollowUp(task.ID, in)
	if err != nil || duplicate.State != "running" || duplicate.ClaimID != "" {
		t.Fatal("duplicate resubmitted or leaked claim", duplicate, err)
	}
	for _, claim := range []string{"", "someone-else"} {
		if _, err = reopened.CompleteFollowUp(task.ID, in.RequestID, claim, "completed", "not mine"); err == nil {
			t.Fatal("wrong owner completed")
		}
	}
	finished, err := reopened.CompleteFollowUp(task.ID, in.RequestID, owner.ClaimID, "uncertain", "No reliable execution receipt. Do not replay.")
	if err != nil || finished.State != "uncertain" || finished.FinishedAt == "" {
		t.Fatal(finished, err)
	}
	again, err := reopened.CompleteFollowUp(task.ID, in.RequestID, owner.ClaimID, finished.State, finished.Reply)
	if err != nil || !reflect.DeepEqual(finished, again) {
		t.Fatal("same terminal receipt not idempotent", again, err)
	}
	if _, err = reopened.CompleteFollowUp(task.ID, in.RequestID, owner.ClaimID, "completed", "late different result"); !errors.Is(err, ErrConflict) {
		t.Fatal("final reply was revised", err)
	}
	if _, err = reopened.ClaimFollowUp(task.ID, in.RequestID); !errors.Is(err, ErrConflict) {
		t.Fatal("uncertain replayed", err)
	}
	if after := followUpTaskBytes(t, s, task.ID); after != before {
		t.Fatal("claim/completion changed task JSON")
	}
	// Terminal state frees the explicit submission slot, not the original identity.
	next := in
	next.RequestID = "fresh-client-request"
	next.Kind = "adjust"
	if _, err = reopened.SubmitFollowUp(task.ID, next); err != nil {
		t.Fatal(err)
	}
}

func TestFollowUpStalePinsAndClaimBlockedWithoutDispatch(t *testing.T) {
	s, task, _, in := followUpFixture(t)
	for _, change := range []func(*FollowUpInput){func(i *FollowUpInput) { i.ReportEventID = "stale-report" }, func(i *FollowUpInput) { i.RunID = "stale-run" }} {
		stale := in
		change(&stale)
		if _, err := s.SubmitFollowUp(task.ID, stale); !errors.Is(err, ErrConflict) {
			t.Fatal("stale submission accepted", err)
		}
	}
	if _, err := s.SubmitFollowUp(task.ID, in); err != nil {
		t.Fatal(err)
	}
	newer, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Newer exact report", Origin: "fixture", Evidence: []Evidence{{Excerpt: "new result"}}})
	if err != nil {
		t.Fatal(err)
	}
	before := followUpTaskBytes(t, s, task.ID)
	blocked, err := s.ClaimFollowUp(task.ID, in.RequestID)
	if !errors.Is(err, ErrConflict) || blocked.State != "blocked" || blocked.ClaimID != "" || blocked.FinishedAt == "" {
		t.Fatal("stale claim not safely blocked", blocked, err)
	}
	if _, err = s.ClaimFollowUp(task.ID, in.RequestID); !errors.Is(err, ErrConflict) {
		t.Fatal("blocked request replayed", err)
	}
	if after := followUpTaskBytes(t, s, task.ID); after != before {
		t.Fatal("stale claim changed current task")
	}
	next := in
	next.RequestID = "new-request"
	next.ReportEventID = CurrentReadyReportID(newer)
	if _, err = s.SubmitFollowUp(task.ID, next); err != nil {
		t.Fatal(err)
	}
}

func TestFollowUpValidationAndNoStartupClaim(t *testing.T) {
	s, task, _, in := followUpFixture(t)
	for _, change := range []func(*FollowUpInput){func(i *FollowUpInput) { i.RequestID = "" }, func(i *FollowUpInput) { i.RequestID = "bad id" }, func(i *FollowUpInput) { i.Kind = "accept" }, func(i *FollowUpInput) { i.Message = " \n" }, func(i *FollowUpInput) { i.Message = strings.Repeat("界", 8001) }, func(i *FollowUpInput) { i.Message = string([]byte{0xff}) }} {
		bad := in
		change(&bad)
		if _, err := s.SubmitFollowUp(task.ID, bad); err == nil {
			t.Fatal("invalid submission accepted", bad)
		}
	}
	if list, err := s.ListFollowUps(task.ID); err != nil || len(list) != 0 {
		t.Fatal("invalid requests saved", list, err)
	}
	for _, mode := range []string{"working", "blocked", "not_started", "demo", "synthetic", "empty-evidence"} {
		t.Run(mode, func(t *testing.T) {
			s, task, _, in := followUpFixture(t)
			var err error
			switch mode {
			case "demo":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.project_id','demo') WHERE id=?`, task.ID)
			case "synthetic":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.source','synthetic') WHERE id=?`, task.ID)
			case "empty-evidence":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.evidence',json('[]')) WHERE id=?`, task.ID)
			default:
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.status',?) WHERE id=?`, mode, task.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.SubmitFollowUp(task.ID, in); !errors.Is(err, ErrConflict) {
				t.Fatal("ineligible accepted", err)
			}
		})
	}
	path := filepath.Join(t.TempDir(), "pending.db")
	fresh, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	task, err = fresh.Create(CreateInput{Title: "Fixture", Goal: "Synthetic only", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	task, err = fresh.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Exact", Origin: "fixture", Evidence: []Evidence{{Excerpt: "synthetic"}}})
	if err != nil {
		t.Fatal(err)
	}
	in.RunID, in.ReportEventID = task.RunID, CurrentReadyReportID(task)
	if _, err = fresh.SubmitFollowUp(task.ID, in); err != nil {
		t.Fatal(err)
	}
	fresh.Close()
	fresh, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	list, err := fresh.ListFollowUps(task.ID)
	if err != nil || len(list) != 1 || list[0].State != "pending" || list[0].ClaimedAt != "" {
		t.Fatal("startup claimed request", list, err)
	}
}

func TestFollowUpIndependentStoresHaveOneClaimant(t *testing.T) {
	s, task, path, in := followUpFixture(t)
	other, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err = s.SubmitFollowUp(task.ID, in); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, handle := range []*Store{s, other} {
		go func(handle *Store) { <-start; _, e := handle.ClaimFollowUp(task.ID, in.RequestID); results <- e }(handle)
	}
	close(start)
	successes, conflicts := 0, 0
	for i := 0; i < 2; i++ {
		err = <-results
		if err == nil {
			successes++
		} else if errors.Is(err, ErrConflict) {
			conflicts++
		} else {
			t.Fatal("unexpected lock failure", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal(successes, conflicts)
	}
}

func TestFollowUpBoundedHistoryRetainsDuplicateReceipts(t *testing.T) {
	s, task, _, in := followUpFixture(t)
	var first FollowUp
	for i := 0; i < 50; i++ {
		request := in
		request.RequestID = fmt.Sprintf("request-%d", i)
		f, err := s.SubmitFollowUp(task.ID, request)
		if err != nil {
			t.Fatal(i, err)
		}
		if i == 0 {
			first = f
		}
		owner, err := s.ClaimFollowUp(task.ID, request.RequestID)
		if err != nil {
			t.Fatal(i, err)
		}
		if _, err = s.CompleteFollowUp(task.ID, request.RequestID, owner.ClaimID, "completed", "Synthetic reply"); err != nil {
			t.Fatal(i, err)
		}
	}
	if _, err := s.SubmitFollowUp(task.ID, in); !errors.Is(err, ErrConflict) {
		t.Fatal("unbounded history", err)
	}
	old := in
	old.RequestID = first.RequestID
	duplicate, err := s.SubmitFollowUp(task.ID, old)
	if err != nil || duplicate.State != "completed" || duplicate.Snapshot.Report.ID != first.ReportEventID {
		t.Fatal("duplicate lost at cap", duplicate, err)
	}
	list, err := s.ListFollowUps(task.ID)
	if err != nil || len(list) != 50 {
		t.Fatal("history deleted", len(list), err)
	}
}

func TestFollowUpChangedScopeBlocksPendingClaim(t *testing.T) {
	for _, field := range []string{"title", "goal"} {
		t.Run(field, func(t *testing.T) {
			s, task, _, in := followUpFixture(t)
			if _, err := s.SubmitFollowUp(task.ID, in); err != nil {
				t.Fatal(err)
			}
			if _, err := s.db.Exec(`UPDATE tasks SET data=json_set(data,?,'changed scope') WHERE id=?`, "$."+field, task.ID); err != nil {
				t.Fatal(err)
			}
			f, err := s.ClaimFollowUp(task.ID, in.RequestID)
			if !errors.Is(err, ErrConflict) || f.State != "blocked" || f.ClaimID != "" {
				t.Fatal("scope edit dispatched", f, err)
			}
		})
	}
}
