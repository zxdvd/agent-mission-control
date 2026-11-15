package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

const blockedFixtureSummary = "Essential tests did not run: required fixture setup failed; goal remains incomplete"

func TestCodexRunValidatedBlockedInitialAndResumedAreSavedOnceAndExitNonzero(t *testing.T) {
	for _, mode := range []string{"blocked", "blocked-empty", "resume-blocked"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			var answer <-chan error
			if mode == "resume-blocked" {
				answer = x.answerWhenOpen(t)
			}
			var out bytes.Buffer
			err := codexRun(x.Args, strings.NewReader("Essential tests must actually run; diagnose if setup prevents them."), &out)
			if answer != nil {
				if answerErr := <-answer; answerErr != nil {
					t.Fatal(answerErr)
				}
			}
			if err == nil || !strings.Contains(err.Error(), "status=blocked; goal incomplete") || !strings.Contains(out.String(), "Saved blocked:") || strings.Contains(out.String(), "Saved ready:") {
				t.Fatal("blocked should be saved but non-success exit", err, out.String())
			}
			saved, _ := x.Store.Get(x.Task.ID)
			wantEvidence := 1
			if mode == "blocked-empty" {
				wantEvidence = 0
			}
			if saved.Status != "blocked" || saved.Summary != blockedFixtureSummary || len(saved.Evidence) != wantEvidence || saved.Decision != nil || saved.CodexBinding != nil || store.CurrentReadyReportID(saved) != "" {
				t.Fatal("blocked is not ready/decision delivery", saved)
			}
			failed, ready, decisions, receipts := 0, 0, 0, 0
			for _, event := range saved.Events {
				switch event.Kind {
				case "reports:failed":
					failed++
					if event.Message != blockedFixtureSummary || !strings.Contains(event.Origin, "model-declared blocked diagnosis") || !strings.Contains(event.Origin, fixtureThread) {
						t.Fatal(event)
					}
				case "reports:ready":
					ready++
				case "reports:needs_decision":
					decisions++
				case "reports:receipt":
					receipts++
				}
			}
			if failed != 1 || ready != 0 {
				t.Fatal("explicit blocked report saved more than once", saved.Events)
			}
			calls := fixtureCalls(t, log)
			wantCalls := 1
			if mode == "resume-blocked" {
				wantCalls = 2
				if decisions != 1 || receipts != 1 || len(saved.Commands) != 1 || saved.Commands[0].Status != "acknowledged" {
					t.Fatal("decision ownership broken", saved)
				}
				if !strings.Contains(calls[1].Prompt, "return blocked") || !strings.Contains(calls[1].Prompt, "zero essential tests") {
					t.Fatal("resumed instructions omit incomplete work distinction", calls[1].Prompt)
				}
			}
			if len(calls) != wantCalls {
				t.Fatal("unexpected retry/resume", calls)
			}
			if !strings.Contains(calls[0].Prompt, "return blocked") || !strings.Contains(calls[0].Prompt, "completed diagnostic objective") {
				t.Fatal("initial prompt omits blocked/diagnostic distinction", calls[0].Prompt)
			}
			for _, evidence := range saved.Evidence {
				if evidence.Label != "Observed setup failure" || !strings.Contains(evidence.Excerpt, "zero essential tests") || evidence.Origin != saved.Events[len(saved.Events)-1].Origin {
					t.Fatal("diagnostic evidence not preserved", evidence)
				}
			}
		})
	}
}

func TestCodexBlockedValidationBoundsAndRequiredEmptyDecisionFields(t *testing.T) {
	base := codexResult{Status: "blocked", Summary: "Required tests did not run", Question: "", Options: []string{}, Evidence: []codexEvidence{}}
	if err := validateCodexResult(base); err != nil {
		t.Fatal("zero diagnostic evidence should be valid", err)
	}
	boundary := base
	boundary.Summary = strings.Repeat("界", 2000)
	boundary.Evidence = make([]codexEvidence, 8)
	for i := range boundary.Evidence {
		boundary.Evidence[i] = codexEvidence{Label: strings.Repeat("界", 160), Excerpt: strings.Repeat("界", 2000)}
	}
	if err := validateCodexResult(boundary); err != nil {
		t.Fatal("valid bounded diagnosis rejected", err)
	}
	for _, mode := range []string{"blank-summary", "long-summary", "question", "options", "nil-options", "nil-evidence", "too-many", "blank-label", "long-label", "blank-excerpt", "long-excerpt"} {
		t.Run(mode, func(t *testing.T) {
			bad := base
			bad.Evidence = []codexEvidence{{Label: "Setup", Excerpt: "Observed failure"}}
			switch mode {
			case "blank-summary":
				bad.Summary = " \n"
			case "long-summary":
				bad.Summary = strings.Repeat("界", 2001)
			case "question":
				bad.Question = "Why?"
			case "options":
				bad.Options = []string{"A"}
			case "nil-options":
				bad.Options = nil
			case "nil-evidence":
				bad.Evidence = nil
			case "too-many":
				bad.Evidence = make([]codexEvidence, 9)
			case "blank-label":
				bad.Evidence[0].Label = " "
			case "long-label":
				bad.Evidence[0].Label = strings.Repeat("界", 161)
			case "blank-excerpt":
				bad.Evidence[0].Excerpt = "\t"
			case "long-excerpt":
				bad.Evidence[0].Excerpt = strings.Repeat("界", 2001)
			}
			if err := validateCodexResult(bad); err == nil {
				t.Fatal("invalid blocked result accepted", mode)
			}
		})
	}
	var schema map[string]any
	if err := json.Unmarshal([]byte(codexResultSchema), &schema); err != nil {
		t.Fatal(err)
	}
	props := schema["properties"].(map[string]any)
	statuses := props["status"].(map[string]any)["enum"].([]any)
	if !reflect.DeepEqual(statuses, []any{"needs_decision", "ready", "blocked"}) {
		t.Fatal("schema missing blocked", statuses)
	}
}

func TestCodexMalformedOrNonzeroBlockedCannotBecomeModelDeclaredBlocked(t *testing.T) {
	for _, mode := range []string{"blocked-malformed", "blocked-nonzero", "resume-blocked-nonzero", "resume-decision"} {
		t.Run(mode, func(t *testing.T) {
			log := fakeCodex(t, mode)
			x := newCodexHTTPFixture(t, nil)
			var answer <-chan error
			if strings.HasPrefix(mode, "resume-") {
				answer = x.answerWhenOpen(t)
			}
			var out bytes.Buffer
			err := codexRun(x.Args, strings.NewReader("Fixture only"), &out)
			if answer != nil {
				if answerErr := <-answer; answerErr != nil {
					t.Fatal(answerErr)
				}
			}
			if err == nil || strings.Contains(out.String(), "Saved blocked:") || strings.Contains(out.String(), "Saved ready:") {
				t.Fatal("unvalidated outcome claimed saved", err, out.String())
			}
			saved, _ := x.Store.Get(x.Task.ID)
			if saved.Status != "blocked" || saved.Summary == blockedFixtureSummary || !strings.HasPrefix(saved.Summary, "Codex bridge stopped:") || len(saved.Evidence) != 0 || strings.Contains(saved.Events[len(saved.Events)-1].Origin, "model-declared blocked diagnosis") {
				t.Fatal("unvalidated model diagnosis acquired authority", saved)
			}
			failed := 0
			for _, event := range saved.Events {
				if event.Kind == "reports:failed" {
					failed++
				}
			}
			if failed != 1 {
				t.Fatal("repeated failure writes", saved.Events)
			}
			wantCalls := 1
			if answer != nil {
				wantCalls = 2
			}
			if len(fixtureCalls(t, log)) != wantCalls {
				t.Fatal("retried failed execution")
			}
		})
	}
}

func TestCodexBlockedSaveMismatchOrUnknownNeverPostsFallback(t *testing.T) {
	for _, mode := range []string{"evidence", "empty-evidence", "decision", "binding", "summary", "status", "event", "task", "malformed", "server-error", "disconnect", "reject"} {
		t.Run(mode, func(t *testing.T) {
			fixtureMode := "blocked"
			if mode == "empty-evidence" {
				fixtureMode = "blocked-empty"
			}
			log := fakeCodex(t, fixtureMode)
			reportPosts := 0
			x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, next http.Handler) bool {
				if r.Method != "POST" || !strings.HasSuffix(r.URL.Path, "/reports") {
					return false
				}
				reportPosts++
				data, _ := io.ReadAll(r.Body)
				r.Body = io.NopCloser(bytes.NewReader(data))
				var in store.Input
				json.Unmarshal(data, &in)
				if in.Kind != "failed" || !strings.Contains(in.Origin, "model-declared blocked diagnosis") {
					t.Error("unexpected generic failure overwrite", in)
					return false
				}
				if mode == "reject" {
					w.WriteHeader(400)
					return true
				}
				rec := httptest.NewRecorder()
				next.ServeHTTP(rec, r)
				if rec.Code != 200 {
					t.Error(rec.Code, rec.Body.String())
				}
				switch mode {
				case "disconnect":
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return true
					}
					conn.Close()
					return true
				case "server-error":
					w.WriteHeader(503)
					return true
				case "malformed":
					w.Write([]byte("not-json"))
					return true
				}
				var saved store.Task
				json.Unmarshal(rec.Body.Bytes(), &saved)
				switch mode {
				case "evidence":
					saved.Evidence[0].Excerpt = "Changed diagnosis"
				case "empty-evidence":
					saved.Evidence = []store.Evidence{{Label: "Unexpected", Excerpt: "Unexpected retained evidence"}}
				case "decision":
					saved.Decision = &store.Decision{Question: "Unexpected", Options: []string{"A", "B"}}
				case "binding":
					saved.CodexBinding = &store.CodexBinding{}
				case "summary":
					saved.Summary = "Changed summary"
				case "status":
					saved.Status = "ready"
				case "event":
					saved.Events[len(saved.Events)-1].Message = "Changed event"
				case "task":
					saved.ID = "other-task"
				}
				json.NewEncoder(w).Encode(saved)
				return true
			})
			var out bytes.Buffer
			err := codexRun(x.Args, strings.NewReader("Fixture only"), &out)
			if err == nil || !strings.Contains(err.Error(), "no further writes or native resume") || strings.Contains(out.String(), "Saved blocked:") || reportPosts != 1 || len(fixtureCalls(t, log)) != 1 {
				t.Fatal("unknown/rejected blocked save triggered second action", err, out.String(), reportPosts)
			}
			saved, _ := x.Store.Get(x.Task.ID)
			wantEvidence := 1
			if mode == "empty-evidence" {
				wantEvidence = 0
			}
			if mode == "reject" {
				if saved.Status != "working" {
					t.Fatal("rejected report altered task", saved)
				}
			} else if saved.Status != "blocked" || saved.Summary != blockedFixtureSummary || len(saved.Evidence) != wantEvidence {
				t.Fatal("committed diagnosis was overwritten", saved)
			}
		})
	}
}

func TestCodexPostFailedNilEvidenceStillRetainsLegacyBridgeBehavior(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	prior := []store.Evidence{{Label: "Earlier", Excerpt: "Existing generic evidence"}}
	if _, err := x.Store.Apply(x.Task.ID, "reports", store.Input{RunID: x.Task.RunID, Kind: "progress", Message: "Earlier progress", Origin: "fixture", Evidence: prior}); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{}
	defer client.CloseIdleConnections()
	saved, err := codexPost(context.Background(), client, strings.TrimPrefix(x.Server.URL, "http://"), x.Task.ID, x.Task.RunID, "reports", store.Input{Kind: "failed", Message: "Bridge failure", Origin: "fixture"}, "reports:failed")
	if err != nil || !reflect.DeepEqual(saved.Evidence, prior) {
		t.Fatal("nil bridge failure evidence contract changed", err, saved)
	}
}

func TestCodexBlockedWithoutEvidenceOrObservedStartNeverBecomesPrestartRetry(t *testing.T) {
	// A successful turn's blocked diagnosis must not be confused with a pre-start
	// bridge failure, even when the independent display observation was lost.
	log := fakeCodex(t, "blocked-empty")
	x := newCodexHTTPFixture(t, func(w http.ResponseWriter, r *http.Request, _ http.Handler) bool {
		if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/codex-observed-start") {
			w.WriteHeader(503)
			return true
		}
		return false
	})
	var out bytes.Buffer
	if err := codexRun(x.Args, strings.NewReader("Required tests must actually run"), &out); err == nil || !strings.Contains(out.String(), "Saved blocked:") {
		t.Fatal(err, out.String())
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if saved.CodexStart != nil || len(saved.Evidence) != 0 || len(saved.Events) != 3 || saved.Status != "blocked" || store.RetryableFailedEventID(saved) != "" || len(fixtureCalls(t, log)) != 1 {
		t.Fatal("model diagnosis became pre-start retry eligible", saved)
	}
	if _, err := x.Store.NewAttempt(saved.ID, store.NewAttemptInput{RunID: saved.RunID, FailedEventID: saved.Events[len(saved.Events)-1].ID, ConfirmStopped: true}); err == nil {
		t.Fatal("stopped attestation allowed retry after validated model turn")
	}
	after, _ := x.Store.Get(saved.ID)
	if !reflect.DeepEqual(saved, after) {
		t.Fatal("rejected retry mutated model diagnosis")
	}
}
