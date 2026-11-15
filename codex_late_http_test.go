package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

// This controlled integration exercises the browser's HTTP answer route, not
// an actual browser UI or a real model. The synthetic native process is launched
// only by the original explicit run and the later explicit -continue command.
func TestCodexLateHTTPAnswerContinuesOriginalThreadOnce(t *testing.T) {
	log := fakeCodex(t, "decision")
	x := newCodexHTTPFixture(t, nil)
	expired := expireCodexDecision(t, x)
	if len(fixtureCalls(t, log)) != 1 || len(expired.Evidence) != 0 {
		t.Fatal("expiry launched a continuation or produced delivery", expired)
	}
	body, err := json.Marshal(store.Input{RunID: expired.RunID, Answer: fixtureAnswer, Decision: expired.Decision})
	if err != nil {
		t.Fatal(err)
	}
	postAnswer := func(wantStatus int) {
		t.Helper()
		resp, err := http.Post(x.Server.URL+"/api/tasks/"+expired.ID+"/decisions", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		if readErr != nil || resp.StatusCode != wantStatus {
			t.Fatal("late answer HTTP", resp.StatusCode, readErr, string(data))
		}
	}
	postAnswer(http.StatusOK)
	answered, err := x.Store.Get(expired.ID)
	if err != nil || answered.ID != expired.ID || answered.RunID != expired.RunID || answered.Status != "needs_decision" || !reflect.DeepEqual(answered.Decision, expired.Decision) || !store.SameCodexBinding(answered.CodexBinding, expired.CodexBinding) || len(answered.Commands) != 1 || answered.Commands[0].Status != "recorded" || answered.Commands[0].Message != fixtureAnswer || len(answered.Evidence) != 0 || len(fixtureCalls(t, log)) != 1 {
		t.Fatal("HTTP answer consumed receipt, resumed, or changed the pinned decision", err, answered)
	}
	command := answered.Commands[0]
	postAnswer(http.StatusConflict)
	afterDuplicate, _ := x.Store.Get(expired.ID)
	if !reflect.DeepEqual(answered, afterDuplicate) || len(fixtureCalls(t, log)) != 1 {
		t.Fatal("duplicate late HTTP answer changed or resumed work", afterDuplicate)
	}
	var out bytes.Buffer
	args := append(slicesClone(x.Args), "-continue")
	if err := codexRun(args, nil, &out); err != nil {
		t.Fatal(err, out.String())
	}
	calls := fixtureCalls(t, log)
	if len(calls) != 2 || calls[1].Args[5] != "resume" || calls[1].Args[len(calls[1].Args)-2] != expired.CodexBinding.NativeThreadID || calls[1].Cwd != x.Cwd || calls[1].Args[2] != expired.CodexBinding.Sandbox {
		t.Fatal("explicit continue did not use the original thread and scope exactly once", calls)
	}
	var decisionData map[string]string
	promptData := calls[1].Prompt[strings.LastIndex(calls[1].Prompt, "\n")+1:]
	if json.Unmarshal([]byte(promptData), &decisionData) != nil || decisionData["task_id"] != expired.ID || decisionData["run_id"] != expired.RunID || decisionData["native_thread_id"] != expired.CodexBinding.NativeThreadID || decisionData["command_id"] != command.ID || decisionData["question"] != expired.Decision.Question || decisionData["answer"] != fixtureAnswer {
		t.Fatal("resume did not receive the exact late HTTP answer", calls[1].Prompt)
	}
	ready, err := x.Store.Get(expired.ID)
	if err != nil || ready.ID != expired.ID || ready.RunID != expired.RunID || ready.Status != "ready" || ready.Decision != nil || len(ready.Commands) != 1 || ready.Commands[0].ID != command.ID || ready.Commands[0].Status != "acknowledged" || len(ready.Evidence) != 1 || ready.Evidence[0].Excerpt == "" || !strings.Contains(ready.Evidence[0].Origin, expired.CodexBinding.NativeThreadID) || !strings.Contains(out.String(), "Saved ready:") {
		t.Fatal("same-thread continuation did not yield new declared evidence", err, ready, out.String())
	}
	claims, decisions, receipts, deliveries := 0, 0, 0, 0
	for _, event := range ready.Events {
		switch event.Kind {
		case "codex-start:":
			claims++
		case "decisions:":
			decisions++
		case "reports:receipt":
			receipts++
		case "reports:ready":
			deliveries++
		case "reports:failed":
			t.Fatal("late answer flow wrote a failure", event)
		}
	}
	if claims != 1 || decisions != 1 || receipts != 1 || deliveries != 1 {
		t.Fatal("late answer flow did not retain one exact lifecycle", ready.Events)
	}
	postAnswer(http.StatusConflict)
	if err := codexRun(args, nil, io.Discard); err == nil {
		t.Fatal("duplicate explicit continuation accepted")
	}
	final, _ := x.Store.Get(expired.ID)
	if !reflect.DeepEqual(ready, final) || len(fixtureCalls(t, log)) != 2 {
		t.Fatal("duplicate answer/continuation changed the new evidence or resumed again", final)
	}
}
