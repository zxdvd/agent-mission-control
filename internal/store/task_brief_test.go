package store

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestTaskBriefClaimComparesExactSavedFieldsWithoutPersistingGuard(t *testing.T) {
	for _, field := range []string{"title", "goal", "match"} {
		t.Run(field, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "brief.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			task, err := s.Create(CreateInput{Title: "Read\n$(touch NEVER) 'quoted'", Goal: "Exact goal\n`literal`; do not execute shell labels", Origin: "fixture"})
			if err != nil {
				t.Fatal(err)
			}
			if !ValidFreshTaskBrief(task) {
				t.Fatal(task)
			}
			expected := &TaskBriefExpectation{Title: task.Title, Goal: task.Goal}
			if field != "match" {
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,?,?) WHERE id=?`, "$."+field, "changed "+field, task.ID)
				if err != nil {
					t.Fatal(err)
				}
			}
			before, _ := s.Get(task.ID)
			saved, err := s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture", ExpectedTaskBrief: expected})
			if field != "match" {
				after, _ := s.Get(task.ID)
				if !errors.Is(err, ErrConflict) || !reflect.DeepEqual(before, after) {
					t.Fatal("stale brief consumed claim", err, after)
				}
				return
			}
			if err != nil || saved.Status != "working" || len(saved.Events) != 2 || saved.Events[1].Kind != "codex-start:" {
				t.Fatal(err, saved)
			}
			data, _ := json.Marshal(saved)
			if strings.Contains(string(data), "expected_task_brief") {
				t.Fatal("guard persisted", string(data))
			}
		})
	}
}
