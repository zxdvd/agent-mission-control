package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const missingCodexError = "codex-run requires an installed Codex CLI on PATH; no installation or authentication changes attempted"

func TestCodexMissingThenManualRetryUsesSameUnclaimedRun(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	t.Setenv("PATH", t.TempDir()) // verified absent command, not a launch failure
	var out bytes.Buffer
	err := codexRun(x.Args, strings.NewReader("Do not send this prompt to a notice endpoint"), &out)
	if err == nil || err.Error() != missingCodexError || out.Len() != 0 {
		t.Fatal(err, out.String())
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if saved.Status != "not_started" || saved.RunID != x.Task.RunID || saved.CodexStart != nil || saved.CodexBinding != nil || saved.CodexLaunchNotice == nil || saved.CodexLaunchNotice.Category != "missing_executable" {
		t.Fatal(saved)
	}
	without := saved
	without.CodexLaunchNotice = nil
	if !reflect.DeepEqual(x.Task, without) {
		t.Fatal("preflight consumed claim or lifecycle", saved)
	}
	if len(x.Posts) != 1 || !strings.HasSuffix(x.Posts[0], "/codex-missing") {
		t.Fatal(x.Posts)
	}
	// A duplicate missing check must not refresh the date or append an event.
	if err = codexRun(x.Args, strings.NewReader("Fixture"), io.Discard); err == nil || err.Error() != missingCodexError {
		t.Fatal(err)
	}
	after, _ := x.Store.Get(x.Task.ID)
	if !reflect.DeepEqual(saved, after) {
		t.Fatal("duplicate dirtied task", after)
	}
	log := fakeCodex(t, "ready")
	if err = codexRun(x.Args, strings.NewReader("Explicit manual retry after fixing PATH"), io.Discard); err != nil {
		t.Fatal(err)
	}
	after, _ = x.Store.Get(x.Task.ID)
	if after.Status != "ready" || after.RunID != x.Task.RunID || after.CodexLaunchNotice != nil || len(after.Events) != 3 || after.Events[1].Kind != "codex-start:" || after.Events[2].Kind != "reports:ready" || len(fixtureCalls(t, log)) != 1 {
		t.Fatal(after)
	}
}

func TestCodexMissingContinueAndInvalidInputDoNotWriteNotice(t *testing.T) {
	for _, mode := range []string{"continue", "blank-prompt", "bad-cwd", "ErrDot"} {
		t.Run(mode, func(t *testing.T) {
			x := newCodexHTTPFixture(t, nil)
			args := append([]string{}, x.Args...)
			t.Setenv("PATH", t.TempDir())
			prompt := "Fixture"
			switch mode {
			case "continue":
				args = append(args, "-continue")
			case "blank-prompt":
				prompt = " "
			case "bad-cwd":
				args = append(args, "-cwd", filepath.Join(x.Cwd, "absent"))
			case "ErrDot":
				t.Chdir(x.Cwd)
				t.Setenv("PATH", ".")
				if err := os.WriteFile(filepath.Join(x.Cwd, "codex"), []byte("#!/bin/sh\nexit 9\n"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if err := codexRun(args, strings.NewReader(prompt), io.Discard); err == nil {
				t.Fatal("expected preflight error")
			}
			after, _ := x.Store.Get(x.Task.ID)
			if !reflect.DeepEqual(x.Task, after) || len(x.Posts) != 0 {
				t.Fatal("nonmatching preflight dirtied task", after, x.Posts)
			}
		})
	}
}

func TestCodexMissingDisplayIsBoundedPrivateAndNeverChangesOriginalError(t *testing.T) {
	for _, mode := range []string{"reject", "slow"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int32
			x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, _ http.Handler) bool {
				if !strings.HasSuffix(r.URL.Path, "/codex-missing") {
					t.Error("unexpected action", r.URL.Path)
					return false
				}
				requests.Add(1)
				var fields map[string]any
				if err := json.NewDecoder(r.Body).Decode(&fields); err != nil || len(fields) != 1 || fields["run_id"] == nil {
					t.Error("notice leaked diagnostics", err, fields)
				}
				if mode == "slow" {
					io.Copy(io.Discard, r.Body)
					<-r.Context().Done()
				} else {
					w.WriteHeader(503)
				}
				return true
			})
			t.Setenv("PATH", t.TempDir())
			started := time.Now()
			err := codexRun(x.Args, strings.NewReader("Private prompt"), io.Discard)
			if err == nil || err.Error() != missingCodexError || time.Since(started) > 2*time.Second {
				t.Fatal("display changed original error/deadline", err, time.Since(started))
			}
			saved, _ := x.Store.Get(x.Task.ID)
			if !reflect.DeepEqual(saved, x.Task) || requests.Load() != 1 {
				t.Fatal("display failure changed task/retried", saved, requests.Load())
			}
		})
	}
}
