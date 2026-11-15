package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDecisionReportHTTPRejectsMalformedOptionsWithoutMutation(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	cases := []*store.Decision{
		{Question: " \t\u3000", Options: []string{"A", "B"}},
		{Question: "Scope?", Options: []string{"A", " \n"}},
		{Question: "Scope?", Options: []string{"A", "B", "A"}},
		{Question: "Scope?", Options: []string{"A", strings.Repeat("界", 121)}},
	}
	for _, d := range cases {
		body, _ := json.Marshal(store.Input{RunID: x.Task.RunID, Kind: "needs_decision", Message: "Bad decision", Origin: "fixture", Decision: d})
		req := httptest.NewRequest("POST", "/api/tasks/"+x.Task.ID+"/reports", bytes.NewReader(body))
		req.Host = "127.0.0.1:8787"
		res := httptest.NewRecorder()
		handler(x.Store).ServeHTTP(res, req)
		if res.Code != 400 {
			t.Fatal("invalid API report accepted", res.Code, res.Body.String())
		}
		saved, _ := x.Store.Get(x.Task.ID)
		if !reflect.DeepEqual(saved, x.Task) {
			t.Fatal("invalid API report changed state", saved)
		}
	}
}
func TestGenericWideExactDecisionHTTPCanBeConsumedByWait(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	d := &store.Decision{Question: " " + strings.Repeat("问", 501) + "\n", Options: []string{"A", " A", "A ", " A ", "B", "C", "D", "E", strings.Repeat("界", 120)}}
	body, _ := json.Marshal(store.Input{RunID: x.Task.RunID, Kind: "needs_decision", Message: "Wide generic choice", Origin: "fixture", Decision: d})
	req := httptest.NewRequest("POST", "/api/tasks/"+x.Task.ID+"/reports", bytes.NewReader(body))
	req.Host = "127.0.0.1:8787"
	res := httptest.NewRecorder()
	handler(x.Store).ServeHTTP(res, req)
	if res.Code != 200 {
		t.Fatal("generic wide decision rejected", res.Code, res.Body.String())
	}
	saved, _ := x.Store.Get(x.Task.ID)
	if !reflect.DeepEqual(saved.Decision, d) {
		t.Fatal("HTTP normalized exact text", saved.Decision)
	}
	answered, err := x.Store.Apply(x.Task.ID, "decisions", store.Input{RunID: x.Task.RunID, Decision: d, Answer: " A"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	answer, err := waitDecisionCommand(ctx, client, strings.TrimPrefix(x.Server.URL, "http://"), x.Task.ID, x.Task.RunID, d.Question)
	if err != nil || answer.Message != " A" || answer.ID != answered.Commands[len(answered.Commands)-1].ID {
		t.Fatal("generic consumer disagrees with new write validation", err, answer)
	}
}
func TestGenericDecisionBaselineDoesNotBroadenNativeContract(t *testing.T) {
	base := codexResult{Status: "needs_decision", Summary: "Choose", Question: strings.Repeat("问", 500), Options: []string{"A", "B", "C", "D", "E", "F", "G", strings.Repeat("界", 120)}, Evidence: []codexEvidence{}}
	if err := validateCodexResult(base); err != nil {
		t.Fatal("native boundary rejected", err)
	}
	for _, mode := range []string{"question501", "options9", "option121", "padded"} {
		t.Run(mode, func(t *testing.T) {
			changed := base
			changed.Options = append([]string{}, base.Options...)
			switch mode {
			case "question501":
				changed.Question += "问"
			case "options9":
				changed.Options = append(changed.Options, "I")
			case "option121":
				changed.Options[0] = strings.Repeat("界", 121)
			case "padded":
				changed.Options[0] = " A "
			}
			if err := validateCodexResult(changed); err == nil {
				t.Fatal("native strict boundary broadened")
			}
			genericValid := store.ValidDecision(&store.Decision{Question: changed.Question, Options: changed.Options})
			if genericValid != (mode != "option121") {
				t.Fatal("generic/native boundary conflated", mode, genericValid)
			}
		})
	}
}
