package store

import (
	"reflect"
	"strings"
	"testing"
)

func TestNewDecisionReportsRejectMalformedLabelsAtomically(t *testing.T) {
	cases := map[string]*Decision{
		"missing":             nil,
		"empty-question":      {Question: "", Options: []string{"A", "B"}},
		"whitespace-question": {Question: " \t\n\u3000", Options: []string{"A", "B"}},
		"missing-options":     {Question: "Scope?"},
		"one-option":          {Question: "Scope?", Options: []string{"A"}},
		"blank-option":        {Question: "Scope?", Options: []string{"A", ""}},
		"whitespace-option":   {Question: "Scope?", Options: []string{"A", " \n\u3000"}},
		"duplicate":           {Question: "Scope?", Options: []string{"A", "B", "A"}},
		"padded-duplicate":    {Question: "Scope?", Options: []string{" A ", " A "}},
		"long-ascii":          {Question: "Scope?", Options: []string{"A", strings.Repeat("b", 121)}},
		"long-unicode":        {Question: "Scope?", Options: []string{"A", strings.Repeat("界", 121)}},
	}
	for name, d := range cases {
		t.Run(name, func(t *testing.T) {
			s, before, _ := freshBoundDecision(t)
			if ValidDecision(d) {
				t.Fatal("malformed baseline accepted")
			}
			if _, err := s.Apply(before.ID, "reports", Input{RunID: before.RunID, Kind: "needs_decision", Message: "Replacement", Origin: "fixture", Decision: d}); err == nil {
				t.Fatal("malformed report saved")
			}
			after, err := s.Get(before.ID)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatal("rejection changed bound decision/events/state", err, after)
			}
		})
	}
}
func TestGenericDecisionBaselinePreservesExactWideTextAndUnicodeBoundary(t *testing.T) {
	s, before, _ := freshBoundDecision(t)
	d := &Decision{Question: " \n" + strings.Repeat("问", 501) + "\t ", Options: []string{"A", " A", "A ", " A ", "B", "C", "D", "E", strings.Repeat("界", 120)}}
	want := &Decision{Question: d.Question, Options: append([]string{}, d.Options...)}
	if !ValidDecision(d) {
		t.Fatal("wide generic exact-distinct options rejected")
	}
	saved, err := s.Apply(before.ID, "reports", Input{RunID: before.RunID, Kind: "needs_decision", Message: "Wide generic choice", Origin: "fixture", Decision: d})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(d, want) || !reflect.DeepEqual(saved.Decision, want) || saved.Status != "needs_decision" || saved.Events[len(saved.Events)-1].Kind != "reports:needs_decision" {
		t.Fatal("text normalized or generic limited", saved)
	}
	for i, option := range d.Options {
		if option != want.Options[i] {
			t.Fatal("option normalized")
		}
	}
	answer, err := s.Apply(saved.ID, "decisions", Input{RunID: saved.RunID, Answer: " A", Decision: want})
	if err != nil || answer.Commands[len(answer.Commands)-1].Message != " A" {
		t.Fatal("exact padded answer not usable", err, answer)
	}
}
