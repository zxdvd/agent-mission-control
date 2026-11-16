package main

import (
	"agentworkbench/internal/store"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestNativeBlockedNewAttemptHTTPRequiresExplicitStopAndPreservesSnapshot(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	claim, err := x.Store.Apply(x.Task.ID, "codex-start", store.Input{RunID: x.Task.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = x.Store.ObserveCodexStart(claim.ID, claim.RunID, fixtureThread); err != nil {
		t.Fatal(err)
	}
	origin := "Codex CLI native thread " + fixtureThread + "; model-declared blocked diagnosis and evidence, not independent verification"
	old, err := x.Store.Apply(claim.ID, "reports", store.Input{RunID: claim.RunID, Kind: "failed", Origin: origin, Message: "Required checks could not run", Evidence: []store.Evidence{{Label: "diagnostic", Excerpt: "Fixture setup failed before tests", Origin: origin}}})
	if err != nil {
		t.Fatal(err)
	}
	good := fmt.Sprintf(`{"run_id":%q,"failed_event_id":%q,"confirm_stopped":true}`, old.RunID, store.RetryableFailedEventID(old))
	for _, body := range []string{strings.Replace(good, `true`, `false`, 1), strings.Replace(good, `true`, `null`, 1), strings.Replace(good, `,"confirm_stopped":true`, ``, 1), strings.Replace(good, `true}`, `true,"confirm_stopped":true}`, 1)} {
		if res := postNewAttempt(t, x, old.ID, body); res.Code != 400 {
			t.Fatal("implicit stopped confirmation accepted", res.Code, res.Body.String())
		}
	}
	res := postNewAttempt(t, x, old.ID, good)
	if res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	var fresh store.Task
	if err = json.Unmarshal(res.Body.Bytes(), &fresh); err != nil {
		t.Fatal(err)
	}
	if !store.ValidFreshTaskBrief(fresh) || len(fresh.PreviousBlockedAttempts) != 1 || fresh.PreviousBlockedAttempts[0].RunID != old.RunID || fresh.PreviousBlockedAttempts[0].ReportEventID != old.Events[len(old.Events)-1].ID || !reflect.DeepEqual(fresh.PreviousBlockedAttempts[0].Evidence, old.Evidence) || fresh.PreviousBlockedAttempts[0].CodexStart != *old.CodexStart || !reflect.DeepEqual(old.Events, fresh.Events[:len(old.Events)]) {
		t.Fatal("HTTP retry did not preserve first-turn diagnosis", fresh)
	}
	if res = postNewAttempt(t, x, old.ID, good); res.Code != 409 {
		t.Fatal("stale duplicate accepted", res.Code)
	}
	// No process is launched by the handler, and the fresh attempt remains unclaimed.
	saved, _ := x.Store.Get(old.ID)
	if saved.Status != "not_started" || len(saved.Events) != len(old.Events)+1 || saved.CodexStart != nil {
		t.Fatal("retry unexpectedly started execution", saved)
	}
}
