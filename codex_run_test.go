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
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const fixtureThread = "01234567-89ab-4cde-8123-456789abcdef"
const fixtureAnswer = `Evidence only; $(touch DO_NOT_CREATE) "quoted"`

type fixtureCall struct {
	Args   []string `json:"args"`
	Prompt string   `json:"prompt"`
	Cwd    string   `json:"cwd"`
}

// TestCodexFixtureProcess is the fake installed Codex executable. It receives
// arguments and stdin through a real child process, never invokes a model, and
// emits the real CLI JSONL envelope around a bounded final model result.
func TestCodexFixtureProcess(t *testing.T) {
	if os.Getenv("AWB_FAKE_CODEX") != "1" {
		return
	}
	args := os.Args
	for i, arg := range args {
		if arg == "--" {
			args = args[i+1:]
			break
		}
	}
	prompt, _ := io.ReadAll(os.Stdin)
	cwd, _ := os.Getwd()
	log, err := os.OpenFile(os.Getenv("AWB_FAKE_LOG"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		os.Exit(3)
	}
	json.NewEncoder(log).Encode(fixtureCall{args, string(prompt), cwd})
	log.Close()
	mode := os.Getenv("AWB_FAKE_MODE")
	if mode == "startup-exit" || mode == "startup-exit-zero" || mode == "startup-thread-exit" {
		fmt.Fprintln(os.Stderr, "SYNTHETIC_PRIVATE_STDERR /private/example TOKEN_SENTINEL")
		if mode == "startup-thread-exit" {
			fmt.Printf("{\"type\":\"thread.started\",\"thread_id\":%q}\n", fixtureThread)
		}
		if mode == "startup-exit-zero" {
			os.Exit(0)
		}
		os.Exit(17)
	}
	if mode == "startup-malformed-live" {
		fmt.Fprintln(os.Stderr, "SYNTHETIC_PRIVATE_STDERR /private/example TOKEN_SENTINEL")
		fmt.Println("SYNTHETIC_PRIVATE_STDOUT /private/example TOKEN_SENTINEL")
		time.Sleep(5 * time.Second)
		os.Exit(17)
	}
	if mode == "startup-untrusted-turn" {
		fmt.Println(`{"type":"item.completed","item":{"type":"agent_message","text":"turn.started SYNTHETIC_PRIVATE_STDOUT"}}`)
		time.Sleep(5 * time.Second)
		os.Exit(17)
	}
	resume := false
	for _, arg := range args {
		resume = resume || arg == "resume"
	}
	if mode == "descendant" {
		// Inherits the fixture's stdout and process group after this native
		// parent exits. Without group cleanup + bounded drain this hangs.
		child := exec.Command("sh", "-c", "sleep 10; printf leaked")
		child.Stdout = os.Stdout
		child.Stderr = os.Stderr
		if err := child.Start(); err != nil {
			os.Exit(4)
		}
	}
	if mode == "hang" {
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}
	if mode == "malformed" {
		fmt.Println("not-json")
		os.Exit(0)
	}
	id := fixtureThread
	if mode == "wrong-id" && resume {
		id = "11234567-89ab-4cde-8123-456789abcdef"
	}
	fmt.Printf("{\"type\":\"thread.started\",\"thread_id\":%q}\n", id)
	if mode == "pre-turn-failure" {
		os.Exit(7)
	}
	if mode == "prelude-ready" || mode == "prelude-decision" {
		fmt.Println(`{"type":"item.started","item":{"type":"reasoning","text":"PRETURN fixture only"}}`)
		fmt.Println(`{"type":"item.updated","item":{"type":"todo_list","text":"PRETURN fixture only"}}`)
		fmt.Println(`{"type":"item.completed","item":{"type":"agent_message","text":"PRETURN fixture must never be a result"}}`)
	}
	fmt.Println(`{"type":"turn.started"}`)
	if mode == "controlled-ready" || mode == "controlled-failure" || mode == "controlled-decision" {
		deadline := time.Now().Add(4 * time.Second)
		for {
			if _, err := os.Stat(os.Getenv("AWB_FAKE_RELEASE")); err == nil {
				break
			}
			if time.Now().After(deadline) {
				os.Exit(8)
			}
			time.Sleep(5 * time.Millisecond)
		}
		if mode == "controlled-failure" {
			os.Exit(7)
		}
	}
	// This misleading tool output must never be treated as a final result.
	fmt.Println(`{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"{\"status\":\"ready\"}"}}`)
	result := codexResult{Status: "needs_decision", Summary: "Choose scope before dependent work", Question: "Which exact scope?", Options: []string{"Minimal fix", fixtureAnswer}, Evidence: []codexEvidence{}}
	if resume || mode == "ready" || mode == "prelude-ready" || mode == "controlled-ready" || mode == "descendant" {
		result = codexResult{Status: "ready", Summary: "Disposable fixture completed", Question: "", Options: []string{}, Evidence: []codexEvidence{{Label: "Fake fixture evidence", Excerpt: "Fixture only: observed selected answer and same native thread; no model or real code executed."}}}
	}
	if mode == "blocked" || mode == "blocked-empty" || mode == "blocked-nonzero" || mode == "blocked-malformed" || mode == "resume-blocked" && resume || mode == "resume-blocked-nonzero" && resume {
		result = codexResult{Status: "blocked", Summary: "Essential tests did not run: required fixture setup failed; goal remains incomplete", Question: "", Options: []string{}, Evidence: []codexEvidence{{Label: "Observed setup failure", Excerpt: "Fixture only: zero essential tests ran because a required test dependency was unavailable."}}}
		if mode == "blocked-empty" {
			result.Evidence = []codexEvidence{}
		}
		if mode == "blocked-malformed" {
			result.Question = "Must be empty"
		}
	}
	if mode == "resume-decision" && resume {
		result = codexResult{Status: "needs_decision", Summary: "Another decision", Question: "Again?", Options: []string{"A", "B"}, Evidence: []codexEvidence{}}
	}
	if mode == "empty-evidence" {
		result.Status, result.Question, result.Options = "ready", "", []string{}
	}
	data, _ := json.Marshal(result)
	if mode == "missing-field" {
		data = []byte(`{"status":"ready","summary":"missing question","options":[],"evidence":[{"label":"fake","excerpt":"fake"}]}`)
	}
	json.NewEncoder(os.Stdout).Encode(map[string]any{"type": "item.completed", "item": map[string]string{"type": "agent_message", "text": string(data)}})
	// Actual Codex planning bookkeeping can follow the final agent message.
	fmt.Println(`{"type":"item.completed","item":{"type":"todo_list","items":[{"text":"done","completed":true}]}}`)
	if mode != "incomplete" {
		fmt.Println(`{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`)
	}
	if mode == "after-completed" {
		fmt.Println(`{"type":"turn.started"}`)
	}
	if mode == "blocked-nonzero" || mode == "resume-blocked-nonzero" && resume {
		os.Exit(7)
	}
	os.Exit(0)
}

func fakeCodex(t *testing.T, mode string) string {
	t.Helper()
	dir := t.TempDir()
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// The wrapper contains only the fixed test executable and "$@". User
	// prompt/decision data never appears in a shell source string.
	script := "#!/bin/sh\nexec '" + strings.ReplaceAll(binary, "'", "'\\''") + "' -test.run=^TestCodexFixtureProcess$ -- \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("AWB_FAKE_CODEX", "1")
	// Race-instrumented subprocesses must not add the default one-second
	// atexit sleep to the deliberately short native deadline fixtures.
	t.Setenv("GORACE", "atexit_sleep_ms=0")
	t.Setenv("AWB_FAKE_MODE", mode)
	log := filepath.Join(dir, "calls.jsonl")
	t.Setenv("AWB_FAKE_LOG", log)
	return log
}

func fixtureCalls(t *testing.T, path string) []fixtureCall {
	t.Helper()
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	var calls []fixtureCall
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		var call fixtureCall
		if err := json.Unmarshal(line, &call); err != nil {
			t.Fatal(err, string(line))
		}
		calls = append(calls, call)
	}
	return calls
}

type codexHTTPFixture struct {
	Store  *store.Store
	Task   store.Task
	Server *httptest.Server
	Args   []string
	Cwd    string
	mu     sync.Mutex
	Posts  []string
}

func newCodexHTTPFixture(t *testing.T, intercept func(http.ResponseWriter, *http.Request, http.Handler) bool) *codexHTTPFixture {
	t.Helper()
	cwd := t.TempDir()
	s, err := store.Open(filepath.Join(cwd, "workbench.db"))
	if err != nil {
		t.Fatal(err)
	}
	task, err := s.Create(store.CreateInput{Title: "Opt-in native test", Goal: "Disposable fixture only", Origin: "fixture operator"})
	if err != nil {
		t.Fatal(err)
	}
	x := &codexHTTPFixture{Store: s, Task: task, Cwd: cwd}
	h := handler(s)
	x.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			x.mu.Lock()
			x.Posts = append(x.Posts, r.URL.Path)
			x.mu.Unlock()
		}
		if intercept != nil && intercept(w, r, h) {
			return
		}
		h.ServeHTTP(w, r)
	}))
	x.Args = []string{"-addr", strings.TrimPrefix(x.Server.URL, "http://"), "-task", task.ID, "-run", task.RunID, "-cwd", cwd, "-wait", "2s", "-timeout", "5s"}
	t.Cleanup(func() { x.Server.Close(); s.Close() })
	return x
}

func (x *codexHTTPFixture) answerWhenOpen(t *testing.T) <-chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			saved, err := x.Store.Get(x.Task.ID)
			if err != nil {
				done <- err
				return
			}
			if saved.Decision != nil {
				body, _ := json.Marshal(store.Input{RunID: x.Task.RunID, Answer: fixtureAnswer, Decision: saved.Decision})
				resp, err := http.Post(x.Server.URL+"/api/tasks/"+x.Task.ID+"/decisions", "application/json", bytes.NewReader(body))
				if err != nil {
					done <- err
					return
				}
				resp.Body.Close()
				if resp.StatusCode != 200 {
					done <- fmt.Errorf("answer HTTP %d", resp.StatusCode)
					return
				}
				done <- nil
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		done <- fmt.Errorf("fixture question never opened")
	}()
	return done
}

func TestCodexRunExactNativeContinuation(t *testing.T) {
	log := fakeCodex(t, "decision")
	x := newCodexHTTPFixture(t, nil)
	done := x.answerWhenOpen(t)
	var out bytes.Buffer
	if err := codexRun(x.Args, strings.NewReader("Only a harmless disposable fixture; do not execute outside cwd."), &out); err != nil {
		t.Fatal(err, out.String())
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	calls := fixtureCalls(t, log)
	if len(calls) != 2 {
		t.Fatal(calls)
	}
	for i, call := range calls {
		if call.Cwd != x.Cwd || call.Args[len(call.Args)-1] != "-" {
			t.Fatal(call)
		}
		wantPrefix := []string{"exec", "--sandbox", "read-only", "--cd", x.Cwd}
		if !reflect.DeepEqual(call.Args[:5], wantPrefix) {
			t.Fatal(call.Args)
		}
		for _, arg := range call.Args {
			if strings.Contains(arg, "bypass") || strings.Contains(arg, "ignore") || arg == "--last" || arg == fixtureAnswer {
				t.Fatal("unsafe or interpolated argument", arg)
			}
		}
		if i == 1 {
			if call.Args[5] != "resume" || call.Args[len(call.Args)-2] != fixtureThread {
				t.Fatal(call.Args)
			}
			data := call.Prompt[strings.LastIndex(call.Prompt, "\n")+1:]
			var decision map[string]string
			if json.Unmarshal([]byte(data), &decision) != nil || decision["answer"] != fixtureAnswer || decision["question"] != "Which exact scope?" || decision["native_thread_id"] != fixtureThread || decision["task_id"] != x.Task.ID || decision["run_id"] != x.Task.RunID {
				t.Fatal(call.Prompt)
			}
		}
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if saved.Status != "ready" || len(saved.Commands) != 1 || saved.Commands[0].Status != "acknowledged" || len(saved.Evidence) != 1 || !strings.Contains(saved.Evidence[0].Origin, fixtureThread) || !strings.Contains(out.String(), "Native same-thread turn completed") {
		t.Fatal(saved, out.String())
	}
	if _, err := os.Stat(filepath.Join(x.Cwd, "DO_NOT_CREATE")); !os.IsNotExist(err) {
		t.Fatal("answer evaluated as shell input", err)
	}
	// Repeating the command must fail at the durable claim before native exec.
	if err := codexRun(x.Args, strings.NewReader("duplicate"), io.Discard); err == nil || len(fixtureCalls(t, log)) != 2 {
		t.Fatal("duplicate native launch", err)
	}
}

func TestCodexRunReadyWithoutDecisionAndWorkspaceWrite(t *testing.T) {
	log := fakeCodex(t, "ready")
	x := newCodexHTTPFixture(t, nil)
	if err := codexRun(append(x.Args, "-prompt", "Fixture only", "-sandbox", "workspace-write"), strings.NewReader("ignored"), io.Discard); err != nil {
		t.Fatal(err)
	}
	calls := fixtureCalls(t, log)
	if len(calls) != 1 || calls[0].Args[2] != "workspace-write" {
		t.Fatal(calls)
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if saved.Status != "ready" || len(saved.Commands) != 0 {
		t.Fatal(saved)
	}
}

func TestCodexRunStopsOnNativeProtocolFailure(t *testing.T) {
	for _, mode := range []string{"malformed", "incomplete", "after-completed", "empty-evidence", "missing-field", "wrong-id"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			var done <-chan error
			if mode == "wrong-id" {
				done = x.answerWhenOpen(t)
			}
			var out bytes.Buffer
			err := codexRun(x.Args, strings.NewReader("Fixture only"), &out)
			if done != nil {
				if answerErr := <-done; answerErr != nil {
					t.Fatal(answerErr)
				}
			}
			if err == nil || !strings.Contains(err.Error(), "status=blocked") || strings.Contains(out.String(), "Saved ready") {
				t.Fatal(err, out.String())
			}
			saved, _ := x.Store.Get(x.Task.ID)
			if saved.Status != "blocked" {
				t.Fatal(saved)
			}
			count := 1
			if mode == "wrong-id" {
				count = 2
			}
			if len(fixtureCalls(t, log)) != count {
				t.Fatal("unexpected native retry")
			}
		})
	}
}

func TestCodexRunBoundedDecisionAndNativeTimeouts(t *testing.T) {
	for _, mode := range []string{"decision", "hang", "descendant"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			start := time.Now()
			timeout := "400ms"
			if mode == "decision" {
				timeout = "2s" // isolate decision wait from helper startup overhead
			}
			err := codexRun(append(x.Args, "-wait", "40ms", "-timeout", timeout), strings.NewReader("Fixture only"), io.Discard)
			if err == nil || time.Since(start) > 2*time.Second || len(fixtureCalls(t, log)) != 1 {
				t.Fatal(err, time.Since(start), fixtureCalls(t, log))
			}
			if mode == "decision" && !strings.Contains(err.Error(), "wait timed out") {
				t.Fatal(err)
			}
			if mode != "decision" && !strings.Contains(err.Error(), "deadline") {
				t.Fatal(err)
			}
		})
	}
}

func TestCodexRunAmbiguousReceiptNeverResumesOrRetries(t *testing.T) {
	for _, mode := range []string{"malformed-receipt", "wrong-answer", "duplicate-ack"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, "decision")
			receipts := 0
			x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, next http.Handler) bool {
				if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/reports") {
					return false
				}
				data, _ := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(data))
				var in store.Input
				json.Unmarshal(data, &in)
				if in.Kind != "receipt" {
					return false
				}
				receipts++
				capture := httptest.NewRecorder()
				next.ServeHTTP(capture, r) // receipt may really have committed
				if mode == "malformed-receipt" {
					fmt.Fprint(w, "ambiguous")
				} else if mode == "duplicate-ack" {
					// A second consumer wins the acknowledgement first. The
					// bridge receives the real conflict, not permission to run.
					r.Body = io.NopCloser(bytes.NewReader(data))
					next.ServeHTTP(w, r)
				} else {
					var saved store.Task
					json.Unmarshal(capture.Body.Bytes(), &saved)
					saved.Commands[0].Message = "different answer"
					json.NewEncoder(w).Encode(saved)
				}
				return true
			})
			done := x.answerWhenOpen(t)
			err := codexRun(x.Args, strings.NewReader("Fixture only"), io.Discard)
			if answerErr := <-done; answerErr != nil {
				t.Fatal(answerErr)
			}
			if err == nil || receipts != 1 || len(fixtureCalls(t, log)) != 1 {
				t.Fatal(err, receipts, fixtureCalls(t, log))
			}
			if mode != "duplicate-ack" {
				saved, _ := x.Store.Get(x.Task.ID)
				if saved.Status != "needs_decision" || saved.Commands[0].Status != "acknowledged" || strings.Contains(err.Error(), "status=blocked") {
					t.Fatal("ambiguous committed receipt overwritten", saved, err)
				}
			}
		})
	}
}

func TestCodexRunValidatesScopeBeforeClaim(t *testing.T) {
	log := fakeCodex(t, "ready")
	x := newCodexHTTPFixture(t, nil)
	for _, flags := range [][]string{{"-task", ""}, {"-run", ""}, {"-cwd", ""}, {"-cwd", "/does-not-exist"}, {"-addr", "localhost:8787"}, {"-addr", "example.com:8787"}, {"-sandbox", "danger-full-access"}, {"-wait", "0"}, {"-wait", "6m"}, {"-timeout", "31m"}, {"-prompt", strings.Repeat("x", (64<<10)+1)}, {"unexpected"}} {
		if err := codexRun(append(slicesClone(x.Args), flags...), strings.NewReader("Fixture only"), io.Discard); err == nil {
			t.Fatal("accepted", flags)
		}
	}
	if err := codexRun(x.Args, strings.NewReader("  "), io.Discard); err == nil {
		t.Fatal("accepted blank prompt")
	}
	if len(fixtureCalls(t, log)) != 0 {
		t.Fatal("invalid arguments launched native process")
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	if len(x.Posts) != 0 {
		t.Fatal(x.Posts)
	}
}

func slicesClone(v []string) []string { return append([]string{}, v...) }

func TestCodexJSONLStrictThreadAndTurnEnvelope(t *testing.T) {
	for _, stream := range []string{
		`{"type":"thread.started","thread_id":"not-a-uuid"}`,
		`{"type":"turn.started"}`,
		"{\"type\":\"thread.started\",\"thread_id\":\"" + fixtureThread + "\"}\n{\"type\":\"thread.started\",\"thread_id\":\"" + fixtureThread + "\"}",
		"{\"type\":\"thread.started\",\"thread_id\":\"" + fixtureThread + "\"}\n{\"type\":\"turn.started\"}\n{\"type\":\"turn.completed\"}",
		strings.Repeat("x", (1<<20)+1),
	} {
		if _, _, err := parseCodexJSONL(strings.NewReader(stream), ""); err == nil {
			t.Fatal("accepted invalid envelope")
		}
	}
}

func TestCodexRunCommittedReportWithLostResponseIsNotOverwritten(t *testing.T) {
	for _, kind := range []string{"ready", "needs_decision"} {
		t.Run(kind, func(t *testing.T) {
			mode := "ready"
			if kind == "needs_decision" {
				mode = "decision"
			}
			log := fakeCodex(t, mode)
			failedPosts := 0
			x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, next http.Handler) bool {
				if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/reports") {
					return false
				}
				data, _ := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(data))
				var in store.Input
				json.Unmarshal(data, &in)
				if in.Kind == "failed" {
					failedPosts++
				}
				if in.Kind != kind {
					return false
				}
				next.ServeHTTP(httptest.NewRecorder(), r) // commit before losing response
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return true
				}
				conn.Close()
				return true
			})
			err := codexRun(x.Args, strings.NewReader("Fixture only"), io.Discard)
			saved, _ := x.Store.Get(x.Task.ID)
			if err == nil || !strings.Contains(err.Error(), "saved status unknown") || saved.Status != kind || failedPosts != 0 || len(fixtureCalls(t, log)) != 1 {
				t.Fatal(err, saved, failedPosts, fixtureCalls(t, log))
			}
		})
	}
}

func TestCodexRunAtomicStartAllowsOnlyOneNativeChild(t *testing.T) {
	log := fakeCodex(t, "ready")
	x := newCodexHTTPFixture(t, nil)
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			results <- codexRun(x.Args, strings.NewReader("Fixture only"), io.Discard)
		}()
	}
	close(start)
	successes := 0
	for range 2 {
		if err := <-results; err == nil {
			successes++
		} else if !strings.Contains(err.Error(), "Codex not launched") {
			t.Fatal(err)
		}
	}
	if successes != 1 || len(fixtureCalls(t, log)) != 1 {
		t.Fatal("atomic claim allowed duplicate", successes, fixtureCalls(t, log))
	}
}
