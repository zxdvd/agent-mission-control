package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func expireCodexDecision(t *testing.T, x *codexHTTPFixture, extra ...string) store.Task {
	t.Helper()
	args := append(slicesClone(x.Args), "-wait", "35ms")
	args = append(args, extra...)
	var out bytes.Buffer
	err := codexRun(args, strings.NewReader("Fixture only"), &out)
	saved, readErr := x.Store.Get(x.Task.ID)
	if readErr != nil || err == nil || !strings.Contains(err.Error(), "codex-run -continue") || saved.Status != "needs_decision" || saved.Decision == nil || saved.CodexBinding == nil || len(saved.Commands) != 0 {
		t.Fatal(err, readErr, saved, out.String())
	}
	for _, event := range saved.Events {
		if event.Kind == "reports:failed" || event.Kind == "reports:receipt" {
			t.Fatal("expiry wrote failure or receipt", event)
		}
	}
	return saved
}
func recordLateAnswer(t *testing.T, x *codexHTTPFixture) store.Task {
	t.Helper()
	before, err := x.Store.Get(x.Task.ID)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := x.Store.Apply(x.Task.ID, "decisions", store.Input{RunID: x.Task.RunID, Answer: fixtureAnswer, Decision: before.Decision})
	if err != nil {
		t.Fatal(err)
	}
	return saved
}

func TestCodexRunLateDecisionSameUUIDOnce(t *testing.T) {
	log := fakeCodex(t, "decision")
	x := newCodexHTTPFixture(t, nil)
	// The content is deliberately shell-active; canonical cwd is persisted only
	// as a hash, and copyable terminal instructions must quote it safely.
	x.Cwd = filepath.Join(x.Cwd, "work '$() `backticks`")
	if err := os.Mkdir(x.Cwd, 0700); err != nil {
		t.Fatal(err)
	}
	x.Args = append(x.Args, "-cwd", x.Cwd)
	before := expireCodexDecision(t, x, "-sandbox", "workspace-write")
	data, _ := json.Marshal(before.CodexBinding)
	if strings.Contains(string(data), x.Cwd) || before.CodexBinding.NativeThreadID != fixtureThread || before.CodexBinding.Sandbox != "workspace-write" || !strings.HasPrefix(before.CodexBinding.CWDFingerprint, "sha256:") {
		t.Fatal(string(data))
	}
	recordLateAnswer(t, x)
	// Canonical symlink aliases refer to the same cwd; no prompt is read.
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(x.Cwd, alias); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	args := append(slicesClone(x.Args), "-continue", "-cwd", alias)
	if err := codexRun(args, nil, &out); err != nil {
		t.Fatal(err, out.String())
	}
	calls := fixtureCalls(t, log)
	if len(calls) != 2 || calls[1].Args[5] != "resume" || calls[1].Args[len(calls[1].Args)-2] != fixtureThread || calls[1].Args[2] != "workspace-write" || calls[1].Cwd != x.Cwd || !strings.Contains(calls[1].Prompt, `"answer":`) || !strings.Contains(out.String(), "sandbox=workspace-write") {
		t.Fatal(calls, out.String())
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if saved.Status != "ready" || saved.Decision != nil || len(saved.Evidence) != 1 || len(saved.Commands) != 1 || saved.Commands[0].Status != "acknowledged" || !strings.Contains(saved.Evidence[0].Origin, fixtureThread) {
		t.Fatal(saved)
	}
	claims, receipts := 0, 0
	for _, event := range saved.Events {
		if event.Kind == "codex-start:" {
			claims++
		}
		if event.Kind == "reports:receipt" {
			receipts++
		}
	}
	if claims != 1 || receipts != 1 {
		t.Fatal(claims, receipts)
	}
	if err := codexRun(args, nil, io.Discard); err == nil || len(fixtureCalls(t, log)) != 2 {
		t.Fatal("second attempt ran", err)
	}
}

func TestCodexContinueWrongScopeNeverExecutesOrWrites(t *testing.T) {
	log := fakeCodex(t, "decision")
	x := newCodexHTTPFixture(t, nil)
	expireCodexDecision(t, x)
	before := recordLateAnswer(t, x)
	for _, extra := range [][]string{{"-cwd", t.TempDir()}, {"-run", "wrong-run"}, {"-sandbox", "workspace-write"}, {"-prompt", "new work"}, {"-native-thread", fixtureThread}} {
		args := append(slicesClone(x.Args), "-continue")
		args = append(args, extra...)
		if err := codexRun(args, nil, io.Discard); err == nil {
			t.Fatal("accepted scope", extra)
		}
		after, _ := x.Store.Get(x.Task.ID)
		if !reflect.DeepEqual(before, after) || len(fixtureCalls(t, log)) != 1 {
			t.Fatal("wrong scope changed/executed", extra, after)
		}
	}
}

func TestCodexContinueExpiryPreservesAlreadyRecordedAnswer(t *testing.T) {
	log := fakeCodex(t, "decision")
	var blockGET atomic.Bool
	x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, next http.Handler) bool {
		if blockGET.Load() && r.Method == "GET" {
			<-r.Context().Done()
			return true
		}
		return false
	})
	expireCodexDecision(t, x)
	before := recordLateAnswer(t, x)
	// A total foreground deadline while reading before any receipt leaves the
	// saved answer exactly intact; retry remains explicit and unconsumed.
	blockGET.Store(true)
	err := codexRun(append(slicesClone(x.Args), "-continue", "-timeout", "50ms"), nil, io.Discard)
	after, _ := x.Store.Get(x.Task.ID)
	if err == nil || !reflect.DeepEqual(before, after) || len(fixtureCalls(t, log)) != 1 {
		t.Fatal(err, after)
	}
}

func TestCodexContinueTotalDeadlineWhileWaitingKeepsQuestion(t *testing.T) {
	log := fakeCodex(t, "decision")
	x := newCodexHTTPFixture(t, nil)
	expireCodexDecision(t, x, "-wait", "2s", "-timeout", "400ms")
	if len(fixtureCalls(t, log)) != 1 {
		t.Fatal("unexpected retry")
	}
}

func TestCodexContinueConcurrentReceiptLoserCannotEraseWinner(t *testing.T) {
	log := fakeCodex(t, "decision")
	gate := make(chan struct{})
	var mu sync.Mutex
	arrived, failed := 0, 0
	x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, next http.Handler) bool {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/reports") {
			return false
		}
		data, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(data))
		var in store.Input
		json.Unmarshal(data, &in)
		if in.Kind == "failed" {
			mu.Lock()
			failed++
			mu.Unlock()
		}
		if in.Kind != "receipt" {
			return false
		}
		mu.Lock()
		arrived++
		if arrived == 2 {
			close(gate)
		}
		mu.Unlock()
		select {
		case <-gate:
		case <-time.After(3 * time.Second):
			t.Error("receipt race did not arrive")
			return true
		}
		next.ServeHTTP(w, r)
		return true
	})
	expireCodexDecision(t, x)
	recordLateAnswer(t, x)
	results := make(chan error, 2)
	for range 2 {
		go func() { results <- codexRun(append(slicesClone(x.Args), "-continue"), nil, io.Discard) }()
	}
	successes := 0
	for range 2 {
		if err := <-results; err == nil {
			successes++
		}
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if successes != 1 || failed != 0 || saved.Status != "ready" || len(saved.Evidence) != 1 || len(fixtureCalls(t, log)) != 2 {
		t.Fatal(successes, failed, saved, fixtureCalls(t, log))
	}
}

func TestCodexContinueInvalidMetadataAndStaleQuestionNeverExecutes(t *testing.T) {
	for _, mode := range []string{"missing", "uuid", "run", "cwd", "version", "options", "acked", "duplicate", "question", "source", "claim"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, "decision")
			var changeGET atomic.Bool
			x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, next http.Handler) bool {
				if !changeGET.Load() || r.Method != "GET" {
					return false
				}
				capture := httptest.NewRecorder()
				next.ServeHTTP(capture, r)
				var saved store.Task
				json.Unmarshal(capture.Body.Bytes(), &saved)
				switch mode {
				case "missing":
					saved.CodexBinding = nil
				case "uuid":
					saved.CodexBinding.NativeThreadID = "arbitrary"
				case "run":
					saved.CodexBinding.RunID = "other-run"
				case "cwd":
					saved.CodexBinding.CWDFingerprint = "invalid"
				case "version":
					saved.CodexBinding.Version = 2
				case "options":
					saved.Decision.Options = []string{"changed", "other"}
				case "acked":
					saved.Commands[0].Status = "acknowledged"
				case "duplicate":
					saved.Commands = append(saved.Commands, saved.Commands[0])
				case "question":
					saved.Decision.Question = "different question"
				case "source":
					saved.Source = "synthetic"
				case "claim":
					saved.Events = nil
				}
				json.NewEncoder(w).Encode(saved)
				return true
			})
			expireCodexDecision(t, x)
			before := recordLateAnswer(t, x)
			changeGET.Store(true)
			err := codexRun(append(slicesClone(x.Args), "-continue"), nil, io.Discard)
			after, _ := x.Store.Get(x.Task.ID)
			if err == nil || len(fixtureCalls(t, log)) != 1 || !reflect.DeepEqual(before, after) {
				t.Fatal(mode, err, after)
			}
		})
	}
}

func TestCodexContinueAmbiguousReceiptCannotBeRepeated(t *testing.T) {
	log := fakeCodex(t, "decision")
	receipts, failed := 0, 0
	x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, next http.Handler) bool {
		if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/reports") {
			return false
		}
		data, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(data))
		var in store.Input
		json.Unmarshal(data, &in)
		if in.Kind == "failed" {
			failed++
		}
		if in.Kind != "receipt" {
			return false
		}
		receipts++
		next.ServeHTTP(httptest.NewRecorder(), r)
		fmt.Fprint(w, "lost-response")
		return true
	})
	expireCodexDecision(t, x)
	recordLateAnswer(t, x)
	args := append(slicesClone(x.Args), "-continue")
	for range 2 {
		if err := codexRun(args, nil, io.Discard); err == nil {
			t.Fatal("continued ambiguous receipt")
		}
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if receipts != 1 || failed != 0 || len(fixtureCalls(t, log)) != 1 || saved.Status != "needs_decision" || saved.Commands[0].Status != "acknowledged" {
		t.Fatal(receipts, failed, saved)
	}
}

func TestShellQuoteProtectsCopyableContinueArguments(t *testing.T) {
	value := "work '$(touch NOPE)' `echo NOPE`"
	if got := shellQuote(value); got != "'work '\"'\"'$(touch NOPE)'\"'\"' `echo NOPE`'" {
		t.Fatal(got)
	}
}
