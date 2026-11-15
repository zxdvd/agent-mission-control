package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCodexStartupFailureReportsOnlyValidatedPhaseAndGenuineExitMetadata(t *testing.T) {
	for _, mode := range []string{"startup-exit", "startup-exit-zero", "startup-thread-exit", "startup-malformed-live", "startup-untrusted-turn"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			var out bytes.Buffer
			began := time.Now()
			err := codexRun(x.Args, strings.NewReader("Fixture only"), &out)
			if err == nil || !strings.Contains(err.Error(), "no validated native turn.started observed") || !strings.Contains(err.Error(), "inspect CLI startup locally") || strings.Contains(out.String(), "Saved ready:") || strings.Contains(out.String(), "Saved blocked:") {
				t.Fatal(err, out.String())
			}
			saved, _ := x.Store.Get(x.Task.ID)
			if saved.Status != "blocked" || saved.CodexStart != nil || len(saved.Evidence) != 0 || len(fixtureCalls(t, log)) != 1 {
				t.Fatal("startup failure acquired execution/delivery authority", saved)
			}
			if mode == "startup-exit" || mode == "startup-thread-exit" {
				if !strings.Contains(saved.Summary, "native exit status=17") {
					t.Fatal("lost genuine exit metadata", saved.Summary)
				}
			} else if mode == "startup-exit-zero" {
				if !strings.Contains(saved.Summary, "native exit status=0") {
					t.Fatal("zero exit still requires a validated turn and must not be hidden", saved.Summary)
				}
			} else {
				if !strings.Contains(saved.Summary, "original native exit status unavailable") || strings.Contains(saved.Summary, "native exit status=-1") || strings.Contains(saved.Summary, "native exit status=17") {
					t.Fatal("our parser cancellation became native exit metadata", saved.Summary)
				}
				if time.Since(began) > 2*time.Second {
					t.Fatal("parser failure no longer stops process promptly")
				}
			}
			for _, private := range []string{"SYNTHETIC_PRIVATE_STDERR", "SYNTHETIC_PRIVATE_STDOUT", "TOKEN_SENTINEL", "/private/example"} {
				if strings.Contains(saved.Summary, private) || strings.Contains(out.String(), private) || strings.Contains(err.Error(), private) {
					t.Fatal("raw diagnostic leaked", private)
				}
			}
			failures := 0
			for _, event := range saved.Events {
				if event.Kind == "reports:failed" {
					failures++
				}
			}
			if failures != 1 {
				t.Fatal("startup diagnostic caused additional writes", saved.Events)
			}
		})
	}
}

func TestCodexObservedTurnFailureDoesNotAcquireStartupClassification(t *testing.T) {
	fakeCodex(t, "blocked-nonzero")
	x := newCodexHTTPFixture(t, nil)
	var out bytes.Buffer
	err := codexRun(x.Args, strings.NewReader("Fixture only"), &out)
	if err == nil || strings.Contains(err.Error(), "no validated native turn.started") || strings.Contains(err.Error(), "inspect CLI startup locally") {
		t.Fatal("observed turn mislabeled startup", err, out.String())
	}
}

func TestNativeCodexStartErrorsUseOnlyFixedSanitizedCategories(t *testing.T) {
	for _, tc := range []struct {
		cause    error
		category string
	}{
		{&os.PathError{Op: "fork/exec", Path: "/private/SYNTHETIC_SECRET", Err: fs.ErrPermission}, "permission denied"},
		{&os.PathError{Op: "chdir", Path: "/private/SYNTHETIC_SECRET", Err: fs.ErrNotExist}, "executable or working directory unavailable"},
		{errors.New("SYNTHETIC_SECRET token and project data"), "OS launch failed"},
	} {
		text := nativeCodexStartError(tc.cause).Error()
		if !strings.Contains(text, tc.category) || strings.Contains(text, "SYNTHETIC_SECRET") || strings.Contains(text, "/private/") {
			t.Fatal("raw OS launch error leaked", text)
		}
	}
	// Exercise the real os/exec Start path too, without requiring an installed CLI.
	_, _, err := runCodexTurn(t.Context(), filepath.Join(t.TempDir(), "SYNTHETIC_SECRET"), t.TempDir(), nil, "Fixture only", "")
	if err == nil || !strings.Contains(err.Error(), "executable or working directory unavailable") || strings.Contains(err.Error(), "SYNTHETIC_SECRET") {
		t.Fatal(err)
	}
}
