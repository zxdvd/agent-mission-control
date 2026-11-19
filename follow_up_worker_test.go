package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func followUpWorkerFixture(t *testing.T, kind string) (*store.Store, store.Task, store.FollowUp, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "workbench.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	task, err := s.Create(store.CreateInput{Title: "Follow-up fixture", Goal: "Full explicit goal only", Origin: "synthetic fixture"})
	if err != nil {
		t.Fatal(err)
	}
	evidence := []store.Evidence{{Label: "Historical source", URL: "https://example.com/full/source?q=unabridged", Excerpt: strings.Repeat("long historical text ", 60), Origin: "reporter"}}
	task, err = s.Apply(task.ID, "reports", store.Input{RunID: task.RunID, Kind: "ready", Message: "Full historical report", Origin: "fixture", Evidence: evidence})
	if err != nil {
		t.Fatal(err)
	}
	f, err := s.SubmitFollowUp(task.ID, store.FollowUpInput{RequestID: "follow-fixture", RunID: task.RunID, ReportEventID: store.CurrentReadyReportID(task), Kind: kind, Message: "Explain $(touch NEVER_CREATE) and keep exact quotes: \"yes\""})
	if err != nil {
		t.Fatal(err)
	}
	return s, task, f, path
}

func fixtureFollowUpRunner(t *testing.T, mode string) (followUpWorkerRunner, string) {
	t.Helper()
	log := fakeCodex(t, mode)
	binary, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	return followUpWorkerRunner{binary: binary, isolation: func() error { return nil }, turn: runCodexTurn}, log
}

func workerOpts(task store.Task, cwd string) followUpWorkerOptions {
	return followUpWorkerOptions{task: task.ID, cwd: cwd, timeout: 2 * time.Second}
}

func TestFollowUpWorkerSyntheticReadOnlySnapshotAndNoReplay(t *testing.T) {
	s, task, f, path := followUpWorkerFixture(t, "explain")
	runner, log := fixtureFollowUpRunner(t, "ready")
	cwd := t.TempDir()
	var out bytes.Buffer
	if err := runFollowUpWorkerPass(context.Background(), s, workerOpts(task, cwd), runner, &out); err != nil {
		t.Fatal(err)
	}
	calls := fixtureCalls(t, log)
	if len(calls) != 1 {
		t.Fatal("one request must start exactly once", calls)
	}
	call := calls[0]
	flags := strings.Join(call.Args, " ")
	for _, want := range []string{"exec --strict-config --ephemeral --sandbox read-only", "--cd " + cwd, "--json --output-schema"} {
		if !strings.Contains(flags, want) {
			t.Fatal("missing fixed flags", flags, want)
		}
	}
	for _, forbidden := range []string{"resume", "--add-dir", "--dangerously", "--ignore-rules", "--ignore-user-config", f.Message} {
		if strings.Contains(flags, forbidden) {
			t.Fatal("unsafe arg", flags)
		}
	}
	for _, want := range []string{task.Goal, "historical_delivery_not_new_verification", f.Snapshot.Report.Message, f.Snapshot.Evidence[0].URL, f.Message} {
		// JSON quotes in instruction are escaped; compare the encoded snapshot separately below.
		if want != f.Message && !strings.Contains(call.Prompt, want) {
			t.Fatal("lost explicit snapshot", want)
		}
	}
	if !strings.Contains(call.Prompt, `Explain $(touch NEVER_CREATE) and keep exact quotes: \"yes\"`) {
		t.Fatal("instruction lost or not sent as data", call.Prompt)
	}
	if _, err := os.Stat(filepath.Join(cwd, "NEVER_CREATE")); !os.IsNotExist(err) {
		t.Fatal("prompt became executable", err)
	}
	rows, err := s.ListFollowUps(task.ID)
	if err != nil || len(rows) != 1 || rows[0].State != "completed" || rows[0].ClaimID != "" {
		t.Fatal("completion receipt invalid", rows, err)
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(task, after) {
		t.Fatal("follow-up overwrote original delivery")
	}
	restarted, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	if err := runFollowUpWorkerPass(context.Background(), restarted, workerOpts(task, cwd), runner, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(fixtureCalls(t, log)) != 1 {
		t.Fatal("restart replayed completed request")
	}
}

func TestFollowUpWorkerAdjustmentSkippedWithoutExplicitMode(t *testing.T) {
	s, task, _, _ := followUpWorkerFixture(t, "adjust")
	runner, log := fixtureFollowUpRunner(t, "ready")
	opts := workerOpts(task, t.TempDir())
	for i := 0; i < 2; i++ {
		if err := runFollowUpWorkerPass(context.Background(), s, opts, runner, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	if len(fixtureCalls(t, log)) != 0 {
		t.Fatal("adjustment dispatched without permission")
	}
	rows, _ := s.ListFollowUps(task.ID)
	if rows[0].State != "pending" {
		t.Fatal("skipped adjustment consumed", rows)
	}
}

func TestFollowUpWorkerMissingVettingFailsBeforeClaim(t *testing.T) {
	s, task, _, path := followUpWorkerFixture(t, "explain")
	log := fakeCodex(t, "ready")
	err := followUpWorkerContext(context.Background(), []string{"-db", path, "-task", task.ID, "-cwd", t.TempDir()}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "Read-only shell sandbox alone") {
		t.Fatal(err)
	}
	rows, _ := s.ListFollowUps(task.ID)
	if rows[0].State != "pending" || len(fixtureCalls(t, log)) != 0 {
		t.Fatal("unvetted runner consumed or launched", rows)
	}
}

func TestFollowUpWorkerUncertainProcessNeverRetries(t *testing.T) {
	for _, mode := range []string{"malformed", "incomplete", "hang", "blocked-nonzero"} {
		t.Run(mode, func(t *testing.T) {
			s, task, _, _ := followUpWorkerFixture(t, "explain")
			runner, log := fixtureFollowUpRunner(t, mode)
			opts := workerOpts(task, t.TempDir())
			opts.timeout = 100 * time.Millisecond
			if err := runFollowUpWorkerPass(context.Background(), s, opts, runner, io.Discard); err == nil {
				t.Fatal("unverified turn treated as done")
			}
			rows, _ := s.ListFollowUps(task.ID)
			if rows[0].State != "uncertain" {
				t.Fatal(rows)
			}
			if err := runFollowUpWorkerPass(context.Background(), s, opts, runner, io.Discard); err != nil {
				t.Fatal(err)
			}
			if len(fixtureCalls(t, log)) != 1 {
				t.Fatal("uncertain turn replayed")
			}
		})
	}
}

type lostFollowUpFinish struct{ followUpWorkerStore }

func (s lostFollowUpFinish) CompleteFollowUp(task, request, claim, state, reply string) (store.FollowUp, error) {
	_, err := s.followUpWorkerStore.CompleteFollowUp(task, request, claim, state, reply)
	if err != nil {
		return store.FollowUp{}, err
	}
	return store.FollowUp{}, errors.New("synthetic lost receipt after commit")
}

func TestFollowUpWorkerLostFinishReceiptNeverOverwritesOrReruns(t *testing.T) {
	s, task, _, _ := followUpWorkerFixture(t, "explain")
	runner, log := fixtureFollowUpRunner(t, "ready")
	opts := workerOpts(task, t.TempDir())
	if err := runFollowUpWorkerPass(context.Background(), lostFollowUpFinish{s}, opts, runner, io.Discard); err == nil || !strings.Contains(err.Error(), "receipt unconfirmed") {
		t.Fatal(err)
	}
	rows, _ := s.ListFollowUps(task.ID)
	if rows[0].State != "completed" {
		t.Fatal("lost receipt overwrote committed finish", rows)
	}
	if err := runFollowUpWorkerPass(context.Background(), s, opts, runner, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(fixtureCalls(t, log)) != 1 {
		t.Fatal("lost receipt replayed")
	}
}

func TestFollowUpWorkerRunningClaimNeverReacquired(t *testing.T) {
	s, task, f, path := followUpWorkerFixture(t, "explain")
	if _, err := s.ClaimFollowUp(task.ID, f.RequestID); err != nil {
		t.Fatal(err)
	}
	restarted, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer restarted.Close()
	runner, log := fixtureFollowUpRunner(t, "ready")
	if err := runFollowUpWorkerPass(context.Background(), restarted, workerOpts(task, t.TempDir()), runner, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(fixtureCalls(t, log)) != 0 {
		t.Fatal("running claim reacquired after restart")
	}
}

func TestFollowUpWorkerRacingPassesOneDispatch(t *testing.T) {
	s, task, _, path := followUpWorkerFixture(t, "explain")
	second, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	runner, log := fixtureFollowUpRunner(t, "ready")
	opts := workerOpts(task, t.TempDir())
	var wg sync.WaitGroup
	for _, db := range []followUpWorkerStore{s, second} {
		wg.Add(1)
		go func(db followUpWorkerStore) {
			defer wg.Done()
			_ = runFollowUpWorkerPass(context.Background(), db, opts, runner, io.Discard)
		}(db)
	}
	wg.Wait()
	if len(fixtureCalls(t, log)) != 1 {
		t.Fatal("racing pass dispatched more than once")
	}
}

func TestFollowUpWorkerDedicatedHomeAndWorktreeValidation(t *testing.T) {
	cwd := t.TempDir()
	home := t.TempDir()
	if _, err := validateFollowUpCodexHome(home, true, cwd); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		path string
		ack  bool
	}{{home, false}, {"relative", true}, {cwd, true}, {filepath.Join(cwd, "missing"), true}} {
		if _, err := validateFollowUpCodexHome(test.path, test.ack, cwd); err == nil {
			t.Fatal("unsafe home accepted", test)
		}
	}
	t.Setenv("CODEX_HOME", home)
	if _, err := validateFollowUpCodexHome(home, true, cwd); err == nil {
		t.Fatal("ambient home accepted")
	}
	if err := validateFollowUpWorktree(context.Background(), cwd); err == nil {
		t.Fatal("non-worktree accepted")
	}
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git missing")
	}
	primary := t.TempDir()
	linked := filepath.Join(t.TempDir(), "dedicated")
	for _, args := range [][]string{{"init", primary}, {"-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"}, {"-C", primary, "worktree", "add", "-b", "fixture-worktree", linked}} {
		if data, err := exec.Command(git, args...).CombinedOutput(); err != nil {
			t.Fatal(err, string(data))
		}
	}
	if err := validateFollowUpWorktree(context.Background(), primary); err == nil {
		t.Fatal("primary checkout accepted")
	}
	if err := validateFollowUpWorktree(context.Background(), linked); err != nil {
		t.Fatal("dedicated linked worktree rejected", err)
	}
}

func TestFollowUpWorkerNativeDedicatedHomeAndCancellation(t *testing.T) {
	s, task, _, _ := followUpWorkerFixture(t, "explain")
	runner, log := fixtureFollowUpRunner(t, "ready")
	home := t.TempDir()
	runner.turn = func(ctx context.Context, binary, cwd string, args []string, prompt, id string) (codexResult, string, error) {
		return runFollowUpCodexTurn(ctx, binary, cwd, home, args, prompt)
	}
	if err := runFollowUpWorkerPass(context.Background(), s, workerOpts(task, t.TempDir()), runner, io.Discard); err != nil {
		t.Fatal(err)
	}
	if len(fixtureCalls(t, log)) != 1 {
		t.Fatal("dedicated native runner did not run fixture")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runFollowUpWorkerPass(ctx, s, workerOpts(task, t.TempDir()), runner, io.Discard); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func linkedFollowUpWorktree(t *testing.T) string {
	t.Helper()
	git, err := exec.LookPath("git")
	if err != nil {
		t.Skip("git unavailable")
	}
	primary := t.TempDir()
	linked := filepath.Join(t.TempDir(), "dedicated")
	for _, args := range [][]string{{"init", primary}, {"-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"}, {"-C", primary, "worktree", "add", "-b", "fixture-worktree", linked}} {
		if data, err := exec.Command(git, args...).CombinedOutput(); err != nil {
			t.Fatal(err, string(data))
		}
	}
	return linked
}

func TestFollowUpWorkerRejectsWritableAliasBeforeClaim(t *testing.T) {
	s, task, _, path := followUpWorkerFixture(t, "adjust")
	log := fakeCodex(t, "ready")
	linked := linkedFollowUpWorktree(t)
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(linked, alias); err != nil {
		t.Fatal(err)
	}
	err := followUpWorkerContext(context.Background(), []string{"-db", path, "-task", task.ID, "-cwd", alias, "-allow-adjust", "-codex-home", t.TempDir(), "-ack-vetted-runner"}, io.Discard)
	if err == nil {
		t.Fatal("writable alias accepted; must reject before claiming or dispatching")
	}
	rows, _ := s.ListFollowUps(task.ID)
	if rows[0].State != "pending" || len(fixtureCalls(t, log)) != 0 {
		t.Fatal("invalid writable root consumed request", rows)
	}
}

func TestFollowUpWorkerWritableModeUsesOnlyDedicatedRoot(t *testing.T) {
	s, task, _, path := followUpWorkerFixture(t, "adjust")
	log := fakeCodex(t, "ready")
	linked := linkedFollowUpWorktree(t)
	err := followUpWorkerContext(context.Background(), []string{"-db", path, "-task", task.ID, "-cwd", linked, "-allow-adjust", "-codex-home", t.TempDir(), "-ack-vetted-runner"}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	rows, _ := s.ListFollowUps(task.ID)
	calls := fixtureCalls(t, log)
	if len(calls) != 1 || rows[0].State != "completed" {
		t.Fatal("explicit vetted writable request did not finish", calls, rows)
	}
	args := strings.Join(calls[0].Args, " ")
	for _, fixed := range []string{"sandbox_workspace_write.writable_roots=[]", "sandbox_workspace_write.exclude_slash_tmp=true", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "sandbox_workspace_write.network_access=false"} {
		if !strings.Contains(args, fixed) {
			t.Fatal("missing dedicated-root sandbox hardening", args, fixed)
		}
	}
	if !strings.Contains(args, "--sandbox workspace-write --cd "+linked) || strings.Contains(args, "--add-dir") {
		t.Fatal("writable scope differs", args)
	}
	if !strings.Contains(rows[0].Reply, fixtureThread) || !strings.Contains(rows[0].Reply, "No saved native session") {
		t.Fatal("missing ephemeral provenance", rows[0].Reply)
	}
}
