package store

import (
	"errors"
	"reflect"
	"testing"
)

func TestAnsweredQuestionCannotBeReportedAgain(t *testing.T) {
	s := setup(t)
	task, err := s.Get("t2")
	if err != nil {
		t.Fatal(err)
	}
	question := task.Decision.Question
	options := append([]string{}, task.Decision.Options...)
	if _, err = s.Apply(task.ID, "decisions", Input{RunID: task.RunID, Answer: options[0]}); err != nil {
		t.Fatal(err)
	}
	for _, clear := range []bool{false, true} {
		if clear {
			if _, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "progress", Message: "Manual continuation"}); err != nil {
				t.Fatal(err)
			}
		}
		for _, offered := range [][]string{options, {"Different A", "Different B"}, {options[0], "Changed second option"}} {
			before, _ := s.Get(task.ID)
			_, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "needs_decision", Message: "Reused question", Decision: &Decision{Question: question, Options: offered}})
			after, _ := s.Get(task.ID)
			if !errors.Is(err, ErrConflict) || !reflect.DeepEqual(before, after) {
				t.Fatal("answered question reused or mutated", err, after)
			}
		}
	}
	if _, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "needs_decision", Message: "New question", Decision: &Decision{Question: question + " (new scope)", Options: options}}); err != nil {
		t.Fatal(err)
	}
}
