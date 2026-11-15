package main

import (
	"agentworkbench/internal/store"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func failedHTTPTask(t *testing.T) *codexHTTPFixture {
	t.Helper()
	x := newCodexHTTPFixture(t, nil)
	task, err := x.Store.Apply(x.Task.ID, "codex-start", store.Input{RunID: x.Task.RunID, Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	x.Task, err = x.Store.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Origin: store.CodexBridgeFailureOrigin, Kind: "failed", Message: "Stopped before validated native turn.started"})
	if err != nil {
		t.Fatal(err)
	}
	return x
}
func postNewAttempt(t *testing.T, x *codexHTTPFixture, id, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/tasks/"+id+"/new-attempt", strings.NewReader(body))
	req.Host = "127.0.0.1:8787"
	res := httptest.NewRecorder()
	handler(x.Store).ServeHTTP(res, req)
	return res
}
func TestNewAttemptHTTPStrictInputNoLegacyStoppedInference(t *testing.T) {
	x := failedHTTPTask(t)
	run, fail := x.Task.RunID, x.Task.Events[len(x.Task.Events)-1].ID
	good := fmt.Sprintf(`{"run_id":%q,"failed_event_id":%q,"confirm_stopped":true}`, run, fail)
	for _, body := range []string{
		`null`, `{}`, `[]`, good + ` {}`, good + ` garbage`, strings.Replace(good, `,"confirm_stopped":true`, "", 1), strings.Replace(good, `true`, `false`, 1), strings.Replace(good, `true`, `null`, 1), strings.Replace(good, `true`, `"true"`, 1), strings.Replace(good, `"run_id"`, `"RUN_ID"`, 1), strings.Replace(good, `"run_id"`, `"unknown"`, 1), strings.Replace(good, `"run_id":`, `"run_id":null,"run_id":`, 1), strings.Replace(good, `"run_id":`, `"run_id":3,"run_id":`, 1), strings.Replace(good, `true}`, `true,"confirm_stopped":true}`, 1), strings.Replace(good, `true}`, `true,"extra":0}`, 1), strings.Replace(good, fmt.Sprintf(`%q`, run), `null`, 1), strings.Repeat(" ", 1024) + good,
	} {
		if res := postNewAttempt(t, x, x.Task.ID, body); res.Code != 400 {
			t.Fatal("invalid contract accepted", res.Code, body, res.Body.String())
		}
		after, _ := x.Store.Get(x.Task.ID)
		if !reflect.DeepEqual(x.Task, after) {
			t.Fatal("bad request mutated")
		}
	}
	if res := postNewAttempt(t, x, "missing", good); res.Code != 404 {
		t.Fatal(res.Code)
	}
	if res := postNewAttempt(t, x, x.Task.ID, strings.Replace(good, fmt.Sprintf(`%q`, fail), `"stale-event"`, 1)); res.Code != 409 {
		t.Fatal(res.Code)
	}
	res := postNewAttempt(t, x, x.Task.ID, good)
	if res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	var fresh store.Task
	if err := json.Unmarshal(res.Body.Bytes(), &fresh); err != nil {
		t.Fatal(err)
	}
	if fresh.ID != x.Task.ID || fresh.RunID == run || fresh.Status != "not_started" || !store.ValidFreshTaskBrief(fresh) || !reflect.DeepEqual(x.Task.Events, fresh.Events[:len(x.Task.Events)]) {
		t.Fatal(fresh)
	}
	if res = postNewAttempt(t, x, x.Task.ID, good); res.Code != 409 {
		t.Fatal("repeat accepted", res.Code)
	}
}
func TestCodexTaskBriefNewAttemptReadyAndDecisionUseFreshExecution(t *testing.T) {
	for _, mode := range []string{"ready", "decision"} {
		t.Run(mode, func(t *testing.T) {
			x := failedHTTPTask(t)
			old := x.Task
			fresh, err := x.Store.NewAttempt(old.ID, store.NewAttemptInput{RunID: old.RunID, FailedEventID: store.RetryableFailedEventID(old), ConfirmStopped: true})
			if err != nil {
				t.Fatal(err)
			}
			x.Task = fresh
			log := fakeCodex(t, mode)
			// Fixture args originally pin run 1; use the new exact current run.
			args := append([]string{}, x.Args...)
			for i, arg := range args {
				if arg == "-run" && i+1 < len(args) {
					args[i+1] = fresh.RunID
				}
			}
			args = append(args, "-use-task-brief")
			var answer <-chan error
			if mode == "decision" {
				answer = x.answerWhenOpen(t)
			}
			if err = codexRun(args, forbiddenBriefInput{}, io.Discard); err != nil {
				t.Fatal(err)
			}
			if answer != nil {
				if err = <-answer; err != nil {
					t.Fatal(err)
				}
			}
			calls := fixtureCalls(t, log)
			want := 1
			if mode == "decision" {
				want = 2
			}
			if len(calls) != want {
				t.Fatal(calls)
			}
			for _, arg := range calls[0].Args {
				if arg == "resume" {
					t.Fatal("new attempt reused a native thread")
				}
			}
			saved, _ := x.Store.Get(old.ID)
			if saved.Status != "ready" || saved.RunID != fresh.RunID || !reflect.DeepEqual(old.Events, saved.Events[:len(old.Events)]) {
				t.Fatal(saved)
			}
		})
	}
}
