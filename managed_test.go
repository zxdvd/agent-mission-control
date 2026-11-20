package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"
)

const managedTestThread = "aaaaaaaa-1111-4422-8333-111111111111"

func managedPNG(t *testing.T, sample color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 1, 1))
	img.SetRGBA(0, 0, sample)
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func managedTestImage(b []byte) *managedImageInput {
	return &managedImageInput{Mime: "image/png", Data: base64.StdEncoding.EncodeToString(b)}
}

func managedRequest(t *testing.T, h http.Handler, method, path, origin string, payload any, runCode ...string) *httptest.ResponseRecorder {
	t.Helper()
	var encoded []byte
	if payload != nil {
		var err error
		encoded, err = json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	req.RemoteAddr = "127.0.0.1:21888"
	req.Host = "127.0.0.1:18819"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if len(runCode) != 0 {
		req.Header.Set("X-Workbench-Run-Code", runCode[0])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func managedTestView(t *testing.T, rec *httptest.ResponseRecorder) managedView {
	t.Helper()
	var v managedView
	if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &v) != nil || v.Turns == nil {
		t.Fatalf("wanted HTTP 200 managed view, got %d %s", rec.Code, rec.Body.String())
	}
	return v
}

func managedTestTask(t *testing.T, h http.Handler, img *managedImageInput) store.Task {
	t.Helper()
	post := map[string]any{"title": "Identify the colors", "goal": "Read the screenshot, do not write files.", "origin": "local screenshot test"}
	if img != nil {
		post["image"] = img
	}
	r := managedRequest(t, h, "POST", "/api/tasks", "http://127.0.0.1:18819", post)
	var task store.Task
	if r.Code != http.StatusCreated || json.Unmarshal(r.Body.Bytes(), &task) != nil || task.ID == "" {
		t.Fatalf("create task: %d %s", r.Code, r.Body.String())
	}
	return task
}

func managedEventually(t *testing.T, test func() bool) {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for !test() {
		if time.Now().After(until) {
			t.Fatal("managed turn did not reach expected state")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestManagedCardImagesExactThreadQueueAndSeparateDelivery(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "workbench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	b1, b2 := managedPNG(t, color.RGBA{200, 0, 0, 255}), managedPNG(t, color.RGBA{0, 100, 200, 255})
	dir, _ := filepath.EvalSymlinks(t.TempDir())
	home, _ := filepath.EvalSymlinks(t.TempDir())
	entered, gate := make(chan struct{}), make(chan struct{})
	unlock := func() {
		select {
		case <-gate:
		default:
			close(gate)
		}
	}
	defer unlock()
	resumeEntered, resumeGate := make(chan struct{}), make(chan struct{})
	unlockResume := func() {
		select {
		case <-resumeGate:
		default:
			close(resumeGate)
		}
	}
	defer unlockResume()
	type call struct {
		args     []string
		image    []byte
		expected string
		prompt   string
		path     string
	}
	calls := make(chan call, 6)
	w := &managedWorker{cwd: dir, home: home, owner: "owner1", runner: "fixed"}
	w.turn = func(_ context.Context, _, _ string, args []string, prompt, expect string) (codexResult, string, error) {
		i := slices.Index(args, "--image")
		var img []byte
		var path string
		if i >= 0 {
			path = args[i+1]
			img, _ = os.ReadFile(path)
		}
		calls <- call{slices.Clone(args), img, expect, prompt, path}
		answer := "blue follow-up result"
		if expect == "" {
			close(entered)
			<-gate
			answer = "red initial result"
		} else {
			close(resumeEntered)
			<-resumeGate
		}
		return codexResult{Status: "ready", Summary: answer, Evidence: []codexEvidence{{Label: "visible pixel", Excerpt: answer}}}, managedTestThread, nil
	}
	h := handlerWithManaged(s, w)
	origin := "http://127.0.0.1:18819"
	task := managedTestTask(t, h, managedTestImage(b1))
	if task.Status != "not_started" || len(calls) != 0 {
		t.Fatal("recording and saving image must not dispatch")
	}
	path := "/api/tasks/" + task.ID + "/managed"
	v := managedTestView(t, managedRequest(t, h, "GET", path, "", nil))
	preview := managedRequest(t, h, "GET", v.InitialImageURL, "", nil)
	if !v.Enabled || !v.CanStart || v.Managed || v.CanFollowUp || v.RunID != task.RunID || preview.Code != 200 || !bytes.Equal(preview.Body.Bytes(), b1) || preview.Header().Get("X-Content-Type-Options") != "nosniff" || preview.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" {
		t.Fatalf("initial projection or scoped image not intact: %#v", v)
	}
	list := managedRequest(t, h, "GET", "/api/tasks", "", nil)
	if strings.Contains(list.Body.String(), managedTestImage(b1).Data) || strings.Contains(list.Body.String(), "initial_image_url") {
		t.Fatal("global task list carries attachment data")
	}
	start := map[string]string{"action": "start", "run_id": task.RunID, "request_id": "start-once"}
	bad := managedRequest(t, h, "POST", path, "http://external.invalid", start)
	if bad.Code != 403 {
		t.Fatalf("cross-origin managed start accepted: %d", bad.Code)
	}
	managedTestView(t, managedRequest(t, h, "POST", path, origin, start))
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("managed start not invoked")
	}
	managedTestView(t, managedRequest(t, h, "POST", path, origin, start))
	if _, err := s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "ready", Origin: "competing", Message: "not this thread"}); err == nil {
		t.Fatal("legacy report could overwrite managed execution")
	}
	other := map[string]string{"action": "start", "run_id": task.RunID, "request_id": "duplicate-new-id"}
	if r := managedRequest(t, h, "POST", path, origin, other); r.Code != 409 {
		t.Fatalf("repeat start with another ID not rejected: %d", r.Code)
	}
	follow := map[string]any{"action": "follow_up", "run_id": task.RunID, "request_id": "one-while-running", "message": "What changed?", "image": managedTestImage(b2)}
	v = managedTestView(t, managedRequest(t, h, "POST", path, origin, follow))
	if len(v.Turns) != 2 || v.Turns[1].State != "pending" || v.CanFollowUp {
		t.Fatalf("one queued turn must be visible before running: %#v", v)
	}
	q := managedRequest(t, h, "GET", v.Turns[1].ImageURL, "", nil)
	if q.Code != 200 || !bytes.Equal(q.Body.Bytes(), b2) {
		t.Fatal("follow-up screenshot not stored with its exact turn")
	}
	if len(calls) != 1 {
		t.Fatal("resume started before initial turn completed")
	}
	unlock()
	select {
	case <-resumeEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("queued turn did not resume")
	}
	initial, err := s.Get(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	viewed, err := s.ReviewDelivery(task.ID, task.RunID, store.CurrentReadyReportID(initial))
	if err != nil || viewed.DeliveryReview == nil {
		t.Fatalf("could not simulate viewing the initial result before follow-up reply: %v", err)
	}
	unlockResume()
	managedEventually(t, func() bool {
		v = managedTestView(t, managedRequest(t, h, "GET", path, "", nil))
		return len(v.Turns) == 2 && v.Turns[1].State == "completed"
	})
	if len(calls) != 2 {
		t.Fatal("start and resume must be called exactly once each")
	}
	startCall, resumeCall := <-calls, <-calls
	for i, c := range []call{startCall, resumeCall} {
		imageArg := slices.Index(c.args, "--image")
		if imageArg < 0 || c.args[imageArg+2] != "--json" || c.args[len(c.args)-1] != "-" || slices.Contains(c.args, "--last") || slices.Contains(c.args, "--ephemeral") || !slices.Contains(c.args, "read-only") || !bytes.Equal(c.image, [][]byte{b1, b2}[i]) {
			t.Fatalf("turn %d wrongly scoped or missing a native attachment: %#v", i+1, c)
		}
		if _, err := os.Stat(c.path); !os.IsNotExist(err) {
			t.Fatalf("temporary attachment should not survive turn %d", i+1)
		}
	}
	if startCall.expected != "" || slices.Contains(startCall.args, "resume") || resumeCall.expected != managedTestThread || resumeCall.args[len(resumeCall.args)-2] != managedTestThread || !slices.Contains(resumeCall.args, "resume") || !strings.Contains(resumeCall.prompt, "What changed?") {
		t.Fatalf("expected original UUID on resumed argv: %#v", resumeCall)
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(after, viewed) || after.Status != "ready" || after.Summary != "red initial result" || len(after.Evidence) != 1 || after.Evidence[0].Excerpt != "red initial result" ||
		!strings.Contains(v.Turns[1].Reply, "blue follow-up result") || !v.CanFollowUp || strings.Contains(managedRequest(t, h, "GET", path, "", nil).Body.String(), managedTestThread) {
		t.Fatalf("follow-up replaced original delivery or exposed internal identity: %#v %#v", after, v)
	}
	// A later replay returns the saved receipt, without launching or overwriting.
	managedTestView(t, managedRequest(t, h, "POST", path, origin, follow))
	readBack, _ := s.Get(task.ID)
	if !reflect.DeepEqual(after, readBack) || len(calls) != 0 {
		t.Fatal("same-ID replay changed exact prior delivery or requeued")
	}
}

func TestManagedImageValidationAndUncertainRestart(t *testing.T) {
	db := filepath.Join(t.TempDir(), "workbench.db")
	s, e := store.Open(db)
	if e != nil {
		t.Fatal(e)
	}
	w := &managedWorker{runner: "configA", owner: "first"}
	h := handlerWithManaged(s, w)
	origin := "http://127.0.0.1:18819"
	valid := managedPNG(t, color.RGBA{18, 99, 182, 255})
	in := map[string]any{"title": "observe", "goal": "read", "origin": "test", "image": &managedImageInput{Mime: "image/jpeg", Data: base64.StdEncoding.EncodeToString(valid)}}
	r := managedRequest(t, h, "POST", "/api/tasks", origin, in)
	if r.Code != 400 {
		t.Fatalf("wrong declared MIME accepted: %d", r.Code)
	}
	in["image"] = managedTestImage(valid[:len(valid)-10])
	r = managedRequest(t, h, "POST", "/api/tasks", origin, in)
	if r.Code != 400 {
		t.Fatalf("truncated PNG accepted: %d", r.Code)
	}
	if tasks, _ := s.List(); len(tasks) != 0 {
		t.Fatal("invalid screenshot partially created a card")
	}
	task := managedTestTask(t, h, managedTestImage(valid))
	if added, e := s.QueueManaged(task.ID, w.runner, w.owner, store.ManagedInput{ID: "uncertain-start", RunID: task.RunID, Kind: "start"}); !added || e != nil {
		t.Fatalf("queue fake interruption: %t %v", added, e)
	}
	if _, tr, _, _, e := s.ClaimManaged(task.ID, w.runner, w.owner); tr.State != "running" || e != nil {
		t.Fatalf("claim fake interruption: %#v %v", tr, e)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, e = store.Open(db)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	h = handlerWithManaged(s, &managedWorker{runner: w.runner, owner: "second"})
	path := "/api/tasks/" + task.ID + "/managed"
	v := managedTestView(t, managedRequest(t, h, "GET", path, "", nil))
	if v.CanStart || v.CanFollowUp || len(v.Turns) != 1 || v.Turns[0].State != "uncertain" {
		t.Fatalf("interrupted turn was made replayable: %#v", v)
	}
	data := managedRequest(t, h, "GET", v.InitialImageURL, "", nil)
	if data.Code != 200 || !bytes.Equal(data.Body.Bytes(), valid) {
		t.Fatal("image not durable across reopening SQLite")
	}
}

func TestManagedBlockedTurnLeavesQueuedFollowUpUnsent(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "workbench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	card, err := s.Create(store.CreateInput{Title: "Run", Goal: "Read only", Origin: "test"})
	if err != nil {
		t.Fatal(err)
	}
	request := store.ManagedInput{ID: "fresh", Kind: "start", RunID: card.RunID}
	if _, err := s.QueueManaged(card.ID, "configuration", "instance", request); err != nil {
		t.Fatal(err)
	}
	if _, tr, _, _, err := s.ClaimManaged(card.ID, "configuration", "instance"); err != nil || tr.ID == "" {
		t.Fatalf("start claim: %#v %v", tr, err)
	}
	follow := store.ManagedInput{ID: "ask-other", Kind: "follow_up", RunID: card.RunID, Message: "Another question"}
	if _, err := s.QueueManaged(card.ID, "configuration", "instance", follow); err != nil {
		t.Fatal(err)
	}
	if err := s.FinishManaged(card.ID, card.RunID, "configuration", "instance", request.ID, "blocked", managedTestThread, "Needs a choice", "A or B?", nil); err != nil {
		t.Fatal(err)
	}
	got, state, err := s.ManagedSnapshot(card.ID)
	if err != nil || got.Status != "blocked" || len(state.Turns) != 2 || state.Turns[1].State != "blocked" || state.Turns[1].Message != follow.Message || !strings.Contains(state.Turns[1].Reply, "未发送") {
		t.Fatalf("pending follow-up not retained without dispatch: %#v %v", state, err)
	}
	if _, tr, _, _, err := s.ClaimManaged(card.ID, "configuration", "instance"); err != nil || tr.ID != "" {
		t.Fatalf("pre-question follow-up became runnable: %#v %v", tr, err)
	}
	// A later explicit decision message may bind to the verified original
	// thread, but a different runner fingerprint may not act on the card.
	follow.ID = "new-operator-reply"
	follow.Message = "Choose A"
	if _, err := s.QueueManaged(card.ID, "other-config", "instance", follow); err == nil {
		t.Fatal("different runner configuration gained access to earlier thread")
	}
	if _, err := s.QueueManaged(card.ID, "configuration", "instance", follow); err != nil {
		t.Fatal(err)
	}
	if _, tr, want, _, err := s.ClaimManaged(card.ID, "configuration", "instance"); err != nil || tr.ID != follow.ID || want != managedTestThread {
		t.Fatalf("explicit later message does not use original verified thread: %#v %s %v", tr, want, err)
	}
}

func TestManagedDedicatedRunnerRejectsDifferentNativeUUID(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "fake-codex")
	e := os.WriteFile(binary, []byte("#!/bin/sh\ncat <<'EOF'\n"+
		`{"type":"thread.started","thread_id":"bbbbbbbb-1111-4422-8333-111111111111"}`+"\n"+
		`{"type":"turn.started"}`+"\n"+
		`{"type":"item.completed","item":{"type":"agent_message","text":"{\"status\":\"ready\",\"summary\":\"fake\",\"question\":\"\",\"options\":[],\"evidence\":[{\"label\":\"note\",\"excerpt\":\"result\"}]}"}}`+"\n"+
		`{"type":"turn.completed"}`+"\nEOF\n"), 0700)
	if e != nil {
		t.Fatal(e)
	}
	res, id, err := runDedicatedCodexTurn(context.Background(), binary, dir, dir, nil, "fixture", managedTestThread)
	if err == nil || !strings.Contains(err.Error(), "thread mismatch") || res.Status != "" || id == managedTestThread {
		t.Fatalf("different UUID was accepted: %#v %s %v", res, id, err)
	}
}
