package main

import (
	"agentworkbench/internal/store"
	"context"
	"encoding/json"
	"image/color"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestManagedNoSandboxRequiresExactModeAndLocalUnlockForTextOnly(t *testing.T) {
	cwd, _ := filepath.EvalSymlinks(t.TempDir())
	home, _ := filepath.EvalSymlinks(t.TempDir())
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte("#!/bin/sh\\nexit 111\\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	if _, err := newManagedWorker(home, cwd, false, true); err == nil {
		t.Fatal("no-sandbox configuration accepted without vetted-runner acknowledgement")
	}
	readOnly, err := newManagedWorker(home, cwd, true, false)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := newManagedWorker(home, cwd, true, true)
	if err != nil {
		t.Fatal(err)
	}
	if readOnly.mode() != managedReadOnlyMode || readOnly.runCode != "" ||
		worker.mode() != managedNoSandboxMode || worker.runner == readOnly.runner || len(worker.runCode) != 32 {
		t.Fatal("runner mode, binding or launch secret not correctly separated")
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "workbench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	type invocation struct {
		cwd              string
		argv             []string
		prompt, nativeID string
	}
	calls := make(chan invocation, 4)
	worker.turn = func(_ context.Context, _ string, dir string, argv []string, input, nativeID string) (codexResult, string, error) {
		calls <- invocation{cwd: dir, argv: slices.Clone(argv), prompt: input, nativeID: nativeID}
		return codexResult{Status: "ready", Summary: "Verified task result", Evidence: []codexEvidence{{Label: "Fake result", Excerpt: "Fixture only"}}}, managedTestThread, nil
	}
	h := handlerWithManaged(st, worker)
	web := managedRequest(t, h, "GET", "/", "", nil)
	if web.Header().Get("Content-Security-Policy") != "frame-ancestors 'none'" || web.Header().Get("X-Frame-Options") != "DENY" || strings.Contains(web.Body.String(), worker.runCode) {
		t.Fatal("browser response leaks secret or is frameable")
	}

	origin := "http://127.0.0.1:18819"
	task := managedTestTask(t, h, nil)
	onlyImage := map[string]any{"parts": []map[string]any{{"image": managedTestImage(managedPNG(t, color.RGBA{1, 2, 3, 255}))}}}
	created := managedRequest(t, h, "POST", "/api/tasks/compose", origin, onlyImage)
	var withScreenshot store.Task
	if created.Code != http.StatusCreated || json.Unmarshal(created.Body.Bytes(), &withScreenshot) != nil {
		t.Fatalf("image-only save: %d %s", created.Code, created.Body.String())
	}
	path := "/api/tasks/" + task.ID + "/managed"
	imgPath := "/api/tasks/" + withScreenshot.ID + "/managed"
	get := managedRequest(t, h, "GET", path, "", nil)
	v := managedTestView(t, get)
	if !v.CanStart || v.Mode != managedNoSandboxMode || strings.Contains(get.Body.String(), worker.runCode) {
		t.Fatal("unexpected no-sandbox projection")
	}
	if v := managedTestView(t, managedRequest(t, h, "GET", imgPath, "", nil)); v.CanStart || len(v.InitialParts) != 1 || v.InitialParts[0].ImageURL == "" {
		t.Fatal("saved screenshot should not be executable in no-sandbox mode")
	}
	start := map[string]string{"action": "start", "run_id": task.RunID, "request_id": "exact-start"}
	for _, tc := range []struct {
		mode, origin, code string
		status             int
	}{
		{"", origin, worker.runCode, http.StatusConflict},
		{managedReadOnlyMode, origin, worker.runCode, http.StatusConflict},
		{managedNoSandboxMode, "", worker.runCode, http.StatusForbidden},
		{managedNoSandboxMode, "http://external.example", worker.runCode, http.StatusForbidden},
		{managedNoSandboxMode, origin, "", http.StatusForbidden},
		{managedNoSandboxMode, origin, strings.Repeat("0", 32), http.StatusForbidden},
	} {
		start["mode"] = tc.mode
		w := managedRequest(t, h, "POST", path, tc.origin, start, tc.code)
		if w.Code != tc.status || strings.Contains(w.Body.String(), worker.runCode) {
			t.Fatalf("mode or auth check: got %d, want %d", w.Code, tc.status)
		}
	}
	start["mode"] = managedNoSandboxMode
	imgStart := map[string]string{"action": "start", "run_id": withScreenshot.RunID, "request_id": "image-start", "mode": managedNoSandboxMode}
	if w := managedRequest(t, h, "POST", imgPath, origin, imgStart, worker.runCode); w.Code != http.StatusConflict {
		t.Fatalf("no-sandbox screenshot task accepted: %d", w.Code)
	}
	for _, p := range []string{path, imgPath} {
		if v := managedTestView(t, managedRequest(t, h, "GET", p, "", nil)); len(v.Turns) != 0 || len(calls) != 0 {
			t.Fatal("reading, creating, or rejected action produced execution receipt")
		}
	}
	managedTestView(t, managedRequest(t, h, "POST", path, origin, start, worker.runCode))
	managedEventually(t, func() bool {
		v := managedTestView(t, managedRequest(t, h, "GET", path, "", nil))
		return len(v.Turns) == 1 && v.Turns[0].State == "completed"
	})
	readOnlyProjection := managedTestView(t, managedRequest(t, handlerWithManaged(st, readOnly), "GET", path, "", nil))
	if readOnlyProjection.Mode != managedReadOnlyMode || readOnlyProjection.CanFollowUp {
		t.Fatal("permission mode could change across continuation")
	}
	follow := map[string]any{"action": "follow_up", "run_id": task.RunID, "request_id": "exact-follow-up", "mode": managedNoSandboxMode, "image": managedTestImage(managedPNG(t, color.RGBA{4, 5, 6, 255}))}
	if w := managedRequest(t, h, "POST", path, origin, follow, worker.runCode); w.Code != http.StatusConflict {
		t.Fatalf("no-sandbox screenshot follow-up accepted: %d", w.Code)
	}
	delete(follow, "image")
	follow["message"] = "Write the authorized fix"
	if w := managedRequest(t, h, "POST", path, origin, follow); w.Code != http.StatusForbidden {
		t.Fatalf("follow-up without unlock accepted: %d", w.Code)
	}
	managedTestView(t, managedRequest(t, h, "POST", path, origin, follow, worker.runCode))
	managedEventually(t, func() bool {
		v := managedTestView(t, managedRequest(t, h, "GET", path, "", nil))
		return len(v.Turns) == 2 && v.Turns[1].State == "completed"
	})
	if len(calls) != 2 {
		t.Fatalf("want exactly two fake calls, got %d", len(calls))
	}
	for i := range 2 {
		c := <-calls
		if c.cwd != cwd || !slices.Equal(c.argv[:5], []string{"exec", "--sandbox", "danger-full-access", "--cd", cwd}) ||
			c.argv[len(c.argv)-1] != "-" || slices.Contains(c.argv, "--dangerously-bypass-approvals-and-sandbox") ||
			slices.Contains(c.argv, "--image") || slices.Contains(c.argv, "--last") || strings.Contains(c.prompt, worker.runCode) ||
			!strings.Contains(c.prompt, "Do not push, publish, deploy") {
			t.Fatalf("unexpected invocation %d", i)
		}
		if i == 0 && (c.nativeID != "" || slices.Contains(c.argv, "resume")) ||
			i == 1 && (c.nativeID != managedTestThread || c.argv[5] != "resume" || c.argv[len(c.argv)-2] != managedTestThread ||
				!strings.Contains(c.prompt, "Write the authorized fix")) {
			t.Fatalf("wrong native thread binding for invocation %d", i)
		}
	}
}

func TestManagedNoSandboxCanExplicitlyReuseAccountDefaultCodexHome(t *testing.T) {
	canonicalTemp := func() string {
		path, err := filepath.EvalSymlinks(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		return path
	}
	userHome, cwd, ambient, bin := canonicalTemp(), canonicalTemp(), canonicalTemp(), canonicalTemp()
	home := filepath.Join(userHome, ".codex")
	insideHome := filepath.Join(home, "nested")
	if err := os.MkdirAll(insideHome, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(userHome, "codex-alias")
	if err := os.Symlink(home, alias); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", userHome)
	t.Setenv("CODEX_HOME", ambient)
	t.Setenv("PATH", bin)
	t.Setenv("OPENAI_API_KEY", "fake-ambient")
	t.Setenv("CODEX_WORKBENCH_TEST_IGNORED", "fake-ambient")
	t.Setenv("WORKBENCH_TEST_WANTED_HOME", home)
	t.Setenv("WORKBENCH_TEST_WANTED_CWD", cwd)

	// This fake checks the exact child environment and writes fixture protocol
	// JSON. It never reads config, credentials, sessions, or the real Codex CLI.
	script := `#!/bin/sh
[ "$CODEX_HOME" = "$WORKBENCH_TEST_WANTED_HOME" ] || exit 77
[ "$PWD" = "$WORKBENCH_TEST_WANTED_CWD" ] || exit 78
[ -z "$OPENAI_API_KEY" ] && [ -z "$CODEX_WORKBENCH_TEST_IGNORED" ] || exit 79
/bin/cat <<'JSON'
{"type":"thread.started","thread_id":"aaaaaaaa-1111-4422-8333-111111111111"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"{\"status\":\"ready\",\"summary\":\"fake\",\"question\":\"\",\"options\":[],\"evidence\":[{\"label\":\"note\",\"excerpt\":\"result\"}]}"}}
{"type":"turn.completed"}
JSON
`
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, path, cwd string
		ack, noSandbox  bool
	}{
		{"omitted", "", cwd, true, true},
		{"relative", ".codex", cwd, true, true},
		{"unvetted", home, cwd, false, true},
		{"read-only", home, cwd, true, false},
		{"custom ambient", ambient, cwd, true, true},
		{"symlink", alias, cwd, true, true},
		{"cwd contains home", home, userHome, true, true},
		{"home contains cwd", home, insideHome, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := newManagedWorker(tc.path, tc.cwd, tc.ack, tc.noSandbox); err == nil {
				t.Fatal("accepted a home outside the explicitly permitted combination")
			}
		})
	}
	if _, err := validateFollowUpCodexHome(home, true, cwd); err == nil {
		t.Fatal("separate CLI worker gained access to account default")
	}
	worker, err := newManagedWorker(home, cwd, true, true)
	if err != nil || worker.home != home || worker.runCode == "" {
		t.Fatalf("could not opt into the explicitly configured account default: %v", err)
	}
	dedicated, err := newManagedWorker(canonicalTemp(), cwd, true, true)
	if err != nil || dedicated.runner == worker.runner {
		t.Fatalf("switching to default would not change native runner binding: %v", err)
	}
	result, id, err := worker.run(nil, store.Task{Goal: "Explicit fixture task"}, store.ManagedTurn{Kind: "start"}, "", "")
	if err != nil || id != managedTestThread || result.Status != "ready" {
		t.Fatalf("runtime did not validate and pass the exact configured account default to the fake child: %v", err)
	}
}
