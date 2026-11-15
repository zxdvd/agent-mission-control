package main

import (
	"agentworkbench/internal/store"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

type forbiddenBriefInput struct{}

func (forbiddenBriefInput) Read([]byte) (int, error) { panic("task-brief mode must not read stdin") }

func TestCodexTaskBriefExactOptInReadyAndDecision(t *testing.T) {
	for _, mode := range []string{"ready", "decision"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			task, err := x.Store.Create(store.CreateInput{Title: "Read\n$(touch DO_NOT_CREATE) 'quoted'", Goal: "Keep `literal`; and \"quotes\"\nNo goal text in shell arguments", Origin: "fixture"})
			if err != nil {
				t.Fatal(err)
			}
			x.Task = task
			x.Args = append(x.Args, "-task", task.ID, "-run", task.RunID, "-use-task-brief")
			var answer <-chan error
			if mode == "decision" {
				answer = x.answerWhenOpen(t)
			}
			if err = codexRun(x.Args, forbiddenBriefInput{}, io.Discard); err != nil {
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
			data := calls[0].Prompt[strings.LastIndex(calls[0].Prompt, "\n")+1:]
			var binding map[string]string
			if json.Unmarshal([]byte(data), &binding) != nil || binding["operator_prompt"] != codexSavedTaskBrief(task) || binding["task_id"] != task.ID || binding["run_id"] != task.RunID {
				t.Fatal(calls[0].Prompt)
			}
			for _, call := range calls {
				if call.Cwd != x.Cwd || !reflect.DeepEqual(call.Args[:5], []string{"exec", "--sandbox", "read-only", "--cd", x.Cwd}) {
					t.Fatal(call)
				}
				for _, arg := range call.Args {
					if strings.Contains(arg, "DO_NOT_CREATE") || strings.Contains(arg, "literal") {
						t.Fatal("brief escaped into argv", arg)
					}
				}
			}
			saved, _ := x.Store.Get(task.ID)
			if saved.Status != "ready" || saved.RunID != task.RunID {
				t.Fatal(saved)
			}
			if _, err = os.Stat(filepath.Join(x.Cwd, "DO_NOT_CREATE")); !os.IsNotExist(err) {
				t.Fatal("task labels executed", err)
			}
			raw, _ := json.Marshal(saved)
			if strings.Contains(string(raw), "expected_task_brief") {
				t.Fatal("claim guard persisted")
			}
		})
	}
}

func TestCodexTaskBriefModeConflictsRejectBeforeReadOrClaim(t *testing.T) {
	for _, extra := range [][]string{{"-prompt", "explicit"}, {"-prompt", ""}, {"-continue"}} {
		x := newCodexHTTPFixture(t, nil)
		args := append(append(append([]string{}, x.Args...), "-use-task-brief"), extra...)
		if err := codexRun(args, forbiddenBriefInput{}, io.Discard); err == nil || !strings.Contains(err.Error(), "mutually exclusive") {
			t.Fatal(extra, err)
		}
		after, _ := x.Store.Get(x.Task.ID)
		if !reflect.DeepEqual(x.Task, after) || len(x.Posts) != 0 {
			t.Fatal("conflict changed task", after)
		}
	}
}

func TestCodexTaskBriefReadAndClaimFailuresNeverLaunch(t *testing.T) {
	for _, mode := range []string{"read-error", "malformed", "blank-goal", "demo", "claimed", "old-run", "stale-title", "stale-goal", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, "ready")
			var task store.Task
			x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, h http.Handler) bool {
				if r.Method != "GET" {
					return false
				}
				switch mode {
				case "read-error":
					w.WriteHeader(503)
				case "malformed":
					w.Write([]byte(`not-json`))
				case "timeout":
					<-r.Context().Done()
				default:
					changed := task
					switch mode {
					case "blank-goal":
						changed.Goal = " "
					case "demo":
						changed.ProjectID = "demo"
						changed.Source = "synthetic"
					case "claimed":
						changed.Status = "working"
					case "old-run":
						changed.RunID = "other-run"
					case "stale-title":
						changed.Title = "Earlier title"
					case "stale-goal":
						changed.Goal = "Earlier goal"
					}
					json.NewEncoder(w).Encode(changed)
				}
				return true
			})
			task = x.Task
			args := append(x.Args, "-use-task-brief")
			if mode == "timeout" {
				args = append(args, "-timeout", "35ms")
			}
			started := time.Now()
			if err := codexRun(args, forbiddenBriefInput{}, io.Discard); err == nil {
				t.Fatal("bad read/claim accepted")
			}
			if mode == "timeout" && time.Since(started) > time.Second {
				t.Fatal("read deadline unbounded")
			}
			after, _ := x.Store.Get(task.ID)
			if !reflect.DeepEqual(task, after) || len(fixtureCalls(t, log)) != 0 {
				t.Fatal("failed brief consumed claim/launched", after)
			}
		})
	}
}

func TestCodexTaskBriefKeepsMissingExecutableNoticeAndSameRunRetry(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	t.Setenv("PATH", t.TempDir())
	args := append(x.Args, "-use-task-brief")
	if err := codexRun(args, forbiddenBriefInput{}, io.Discard); err == nil || err.Error() != missingCodexError {
		t.Fatal(err)
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if saved.Status != "not_started" || saved.CodexLaunchNotice == nil || len(saved.Events) != 1 {
		t.Fatal(saved)
	}
	log := fakeCodex(t, "ready")
	if err := codexRun(args, forbiddenBriefInput{}, io.Discard); err != nil {
		t.Fatal(err)
	}
	saved, _ = x.Store.Get(x.Task.ID)
	if saved.Status != "ready" || saved.CodexLaunchNotice != nil || len(fixtureCalls(t, log)) != 1 {
		t.Fatal(saved)
	}
}

func TestCodexSavedTaskBriefMatchesVisibleLiteral(t *testing.T) {
	task := store.Task{Title: "Read\n$(touch NEVER) 'quoted'", Goal: "Line one\n`literal`; \"quoted\""}
	expected := "任务：Read\n$(touch NEVER) 'quoted'\n\n目标与边界：\nLine one\n`literal`; \"quoted\"\n\n交付要求：说明实际改动、验证结果与未完成项。"
	if codexSavedTaskBrief(task) != expected {
		t.Fatal(codexSavedTaskBrief(task))
	}
}
