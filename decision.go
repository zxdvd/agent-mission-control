package main

import (
	"agentworkbench/internal/store"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxDecisionWait      = 5 * time.Minute
	decisionPollInterval = 250 * time.Millisecond
)

// decision takes a read-only snapshot, or explicitly waits for one exact question.
// It neither acknowledges a command nor reads files or starts an execution.
func decision(args []string, out io.Writer) error {
	f := flag.NewFlagSet("decision", flag.ContinueOnError)
	addr := f.String("addr", "127.0.0.1:8787", "loopback workbench address")
	task := f.String("task", "", "exact work item ID (required)")
	run := f.String("run", "", "exact recorded run ID (required)")
	wait := f.Duration("wait", 0, "opt-in bounded wait, at most 5m; requires -question")
	question := f.String("question", "", "exact open question text (-wait only)")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *task == "" || *run == "" {
		return errors.New("decision requires -task and -run; no positional arguments")
	}
	if !loopback(*addr) {
		return errors.New("decision requires an explicit loopback IP address")
	}
	if *wait < 0 || *wait > maxDecisionWait || (*wait > 0 && strings.TrimSpace(*question) == "") || (*wait == 0 && *question != "") {
		return errors.New("decision -wait must be positive and at most 5m with an exact -question; -question is only valid with -wait")
	}
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("redirect refused") }}
	defer client.CloseIdleConnections()
	if *wait > 0 {
		ctx, cancel := context.WithTimeout(context.Background(), *wait)
		defer cancel()
		return waitForDecision(ctx, client, *addr, *task, *run, *question, out)
	}
	saved, err := readDecisionTask(context.Background(), client, *addr, *task, *run)
	if err != nil {
		return err
	}
	// An open question takes precedence over older answers. When no question is
	// open, show the latest decision recorded for this run, never another run.
	var answer *store.Command
	for i := len(saved.Commands) - 1; i >= 0; i-- {
		c := &saved.Commands[i]
		if c.Kind == "decision" && c.RunID == *run && (saved.Decision == nil || c.Question == saved.Decision.Question) {
			answer = c
			break
		}
	}
	var result string
	if answer != nil {
		if answer.ID == "" || answer.Question == "" || answer.Message == "" || (answer.Status != "recorded" && answer.Status != "acknowledged") {
			return errors.New("decision read failed: unexpected decision record")
		}
		if saved.Decision != nil && !slices.Contains(saved.Decision.Options, answer.Message) {
			return errors.New("decision read failed: recorded answer does not match the current options; inspect the question before acting")
		}
		result = fmt.Sprintf("Recorded answer: task=%s run=%s command=%s status=%s\nQuestion: %q\nAnswer: %q\n", saved.ID, saved.RunID, answer.ID, answer.Status, answer.Question, answer.Message)
	} else if saved.Decision != nil {
		if saved.Decision.Question == "" || len(saved.Decision.Options) < 2 {
			return errors.New("decision read failed: unexpected open question")
		}
		result = fmt.Sprintf("Waiting for answer: task=%s run=%s\nQuestion: %q\n", saved.ID, saved.RunID, saved.Decision.Question)
		for _, option := range saved.Decision.Options {
			result += fmt.Sprintf("Option: %q\n", option)
		}
	} else {
		result = fmt.Sprintf("No decision: task=%s run=%s\n", saved.ID, saved.RunID)
	}
	_, err = fmt.Fprint(out, result+"Read-only snapshot; no delivery acknowledgement sent and no Agent execution.\n")
	return err
}

// readDecisionTask is GET-only, bounded, and never sends a receipt.
func readDecisionTask(ctx context.Context, client *http.Client, addr, task, run string) (store.Task, error) {
	var saved store.Task
	req, err := http.NewRequestWithContext(ctx, "GET", "http://"+addr+"/api/tasks/"+url.PathEscape(task), nil)
	if err != nil {
		return saved, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return saved, fmt.Errorf("decision read failed: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil {
		return saved, fmt.Errorf("decision read failed: %w", err)
	}
	if len(data) > 1<<20 {
		return saved, errors.New("decision response exceeds 1 MiB")
	}
	if resp.StatusCode != http.StatusOK {
		return saved, fmt.Errorf("decision read rejected (%d): %s", resp.StatusCode, data)
	}
	if json.Unmarshal(data, &saved) != nil || saved.ID != task || saved.Status == "" {
		return saved, errors.New("decision read failed: unexpected task response")
	}
	if saved.RunID != run {
		return saved, errors.New("decision read failed: execution changed; refresh the exact task/run before reading")
	}
	return saved, nil
}

// waitForDecision pins the open question and first observed options. Unlike the
// snapshot path it cannot return historical answers after the question clears.
func waitForDecision(ctx context.Context, client *http.Client, addr, task, run, question string, out io.Writer) error {
	answer, err := waitDecisionCommand(ctx, client, addr, task, run, question)
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(out, "Recorded answer: task=%s run=%s command=%s status=%s\nQuestion: %q\nAnswer: %q\nRead-only snapshot; no delivery acknowledgement sent and no Agent execution.\n", task, run, answer.ID, answer.Status, answer.Question, answer.Message)
	return err
}

// waitDecisionCommand is the shared exact-question gate. Returning a command is
// read-only; consumers must obtain a separately verified receipt before acting.
func waitDecisionCommand(ctx context.Context, client *http.Client, addr, task, run, question string) (store.Command, error) {
	return waitPinnedDecisionCommand(ctx, client, addr, task, run, question, nil)
}

func waitPinnedDecisionCommand(ctx context.Context, client *http.Client, addr, task, run, question string, binding *store.CodexBinding) (store.Command, error) {
	timeout := func() error {
		return fmt.Errorf("decision wait timed out: task=%s run=%s question=%q; no answer returned, no acknowledgement sent", task, run, question)
	}
	var options []string
	for {
		if ctx.Err() != nil {
			return store.Command{}, timeout()
		}
		saved, err := readDecisionTask(ctx, client, addr, task, run)
		if ctx.Err() != nil {
			return store.Command{}, timeout()
		}
		if err != nil {
			return store.Command{}, err
		}
		if saved.Status != "needs_decision" || saved.Decision == nil || saved.Decision.Question != question {
			return store.Command{}, errors.New("decision wait stopped: expected question is not open; question or task state changed")
		}
		if binding != nil && (!store.SameCodexBinding(saved.CodexBinding, binding) || !store.ValidCodexBinding(saved.CodexBinding, task, run, saved.Decision)) {
			return store.Command{}, errors.New("decision wait stopped: pinned Codex binding or options changed")
		}
		if len(saved.Decision.Options) < 2 {
			return store.Command{}, errors.New("decision wait stopped: unexpected open question options")
		}
		seen := map[string]bool{}
		for _, option := range saved.Decision.Options {
			if strings.TrimSpace(option) == "" || utf8.RuneCountInString(option) > maxCLIOptionLength || seen[option] {
				return store.Command{}, errors.New("decision wait stopped: unexpected open question options")
			}
			seen[option] = true
		}
		if options == nil {
			options = slices.Clone(saved.Decision.Options)
		} else if !slices.Equal(options, saved.Decision.Options) {
			return store.Command{}, errors.New("decision wait stopped: question options changed")
		}
		var answer *store.Command
		for i := range saved.Commands {
			c := &saved.Commands[i]
			if c.Kind != "decision" || c.RunID != run || c.Question != question {
				continue
			}
			if c.Status == "acknowledged" {
				return store.Command{}, errors.New("decision wait stopped: answer already acknowledged; inspect the prior consumer outcome before any further work")
			}
			if answer != nil || c.ID == "" || !seen[c.Message] || c.Status != "recorded" {
				return store.Command{}, errors.New("decision wait stopped: unexpected or duplicate decision record")
			}
			answer = c
		}
		if answer != nil {
			if ctx.Err() != nil {
				return store.Command{}, timeout()
			}
			return *answer, nil
		}
		timer := time.NewTimer(decisionPollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return store.Command{}, timeout()
		case <-timer.C:
		}
	}
}
