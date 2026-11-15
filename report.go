package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

// Decision options are inline labels, not instructions or file references.
const maxCLIOptionLength = store.MaxDecisionOptionLength

type reportOptions []string

func (o *reportOptions) String() string { return strings.Join(*o, ", ") }
func (o *reportOptions) Set(value string) error {
	*o = append(*o, value)
	return nil
}

// report relays explicit content only to this local workbench. It reads no
// evidence files, launches no process, and cannot follow an HTTP redirect.
func report(args []string, out io.Writer) error {
	f := flag.NewFlagSet("report", flag.ContinueOnError)
	addr := f.String("addr", "127.0.0.1:8787", "loopback workbench address")
	task := f.String("task", "", "exact work item ID")
	run := f.String("run", "", "exact recorded run ID (required)")
	kind := f.String("kind", "progress", "progress, needs_decision, ready, completed, failed or receipt")
	command := f.String("command", "", "exact command ID (receipt only)")
	message := f.String("message", "", "report summary")
	origin := f.String("origin", "", "who supplied this report and how it was obtained")
	excerpt := f.String("excerpt", "", "inline evidence, at most 2000 characters; never a file read")
	question := f.String("question", "", "decision question (needs_decision only)")
	var options reportOptions
	f.Var(&options, "option", "decision option, repeat at least twice; each distinct and at most 120 characters")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 || *task == "" || *run == "" || *origin == "" {
		return errors.New("report requires -task, -run and -origin; no positional arguments")
	}
	if !loopback(*addr) {
		return errors.New("report requires an explicit loopback IP address")
	}
	switch *kind {
	case "progress", "needs_decision", "ready", "completed", "failed", "receipt":
	default:
		return errors.New("unsupported report kind")
	}
	if *kind == "receipt" {
		if strings.TrimSpace(*command) == "" || *excerpt != "" {
			return errors.New("receipt requires -command and does not accept -excerpt")
		}
	} else if *command != "" || strings.TrimSpace(*message) == "" {
		return errors.New("reports require -message; -command is only valid with -kind receipt")
	}
	in := store.Input{RunID: *run, Kind: *kind, Message: *message, Origin: *origin, CommandID: *command}
	if *kind == "needs_decision" {
		if strings.TrimSpace(*question) == "" || len(options) < 2 {
			return errors.New("needs_decision requires -question and at least two distinct -option values")
		}
		seen := map[string]bool{}
		for i, option := range options {
			option = strings.TrimSpace(option)
			if option == "" || utf8.RuneCountInString(option) > maxCLIOptionLength || seen[option] {
				return errors.New("decision options must be nonblank, distinct and at most 120 characters each")
			}
			seen[option] = true
			options[i] = option
		}
		in.Decision = &store.Decision{Question: strings.TrimSpace(*question), Options: options}
	} else if *question != "" || len(options) != 0 {
		return errors.New("-question and -option are only valid with -kind needs_decision")
	}
	if *excerpt != "" {
		in.Evidence = []store.Evidence{{Label: "CLI 提供的证据摘录", Excerpt: *excerpt, Origin: *origin}}
	}
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", "http://"+*addr+"/api/tasks/"+url.PathEscape(*task)+"/reports", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("redirect refused") }}
	defer client.CloseIdleConnections()
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("report delivery unconfirmed; inspect the work item before retrying: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil {
		return err
	}
	if len(data) > 1<<20 {
		return errors.New("report delivery unconfirmed; response exceeds 1 MiB; inspect the work item before retrying")
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("report rejected (%d): %s", resp.StatusCode, data)
	}
	var saved store.Task
	if err = json.Unmarshal(data, &saved); err != nil || saved.ID != *task || saved.RunID != *run || saved.Status == "" || len(saved.Events) == 0 {
		return errors.New("report delivery unconfirmed; unexpected response; inspect the work item before retrying")
	}
	event := saved.Events[len(saved.Events)-1]
	if event.ID == "" || event.RunID != *run || event.Kind != "reports:"+*kind {
		return errors.New("report delivery unconfirmed; unexpected report receipt; inspect the work item before retrying")
	}
	if *kind == "completed" && store.CurrentReadyReportID(saved) != event.ID {
		return errors.New("report delivery unconfirmed; completed claim was not queued for review; inspect the work item before retrying")
	}
	if *kind == "receipt" {
		matches := 0
		for _, c := range saved.Commands {
			if c.ID == *command {
				if c.RunID != *run || c.Status != "acknowledged" {
					return errors.New("report delivery unconfirmed; unexpected command acknowledgement; inspect the work item before retrying")
				}
				matches++
			}
		}
		if matches != 1 {
			return errors.New("report delivery unconfirmed; expected one command acknowledgement; inspect the work item before retrying")
		}
		_, err = fmt.Fprintf(out, "Saved receipt report: task=%s run=%s status=%s report=%s command=%s command_status=acknowledged\nRecorded locally only; acknowledgement is reporter-supplied, not proof of Agent execution or continuation.\n", saved.ID, saved.RunID, saved.Status, event.ID, *command)
		return err
	}
	_, err = fmt.Fprintf(out, "Saved %s report: task=%s run=%s status=%s report=%s\nRecorded locally only; no Agent execution or automatic delivery.\n", *kind, saved.ID, saved.RunID, saved.Status, event.ID)
	return err
}
