package store

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestCodexMissingNoticeDoesNotClaimAndClaimClearsIt(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "notice.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(CreateInput{Title: "Fixture", Goal: "No native execution", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	notice, err := s.NoteCodexMissing(task.ID, task.RunID)
	if err != nil {
		t.Fatal(err)
	}
	if notice.Category != "missing_executable" {
		t.Fatal(notice)
	}
	if _, err = time.Parse(time.RFC3339Nano, notice.RecordedAt); err != nil {
		t.Fatal(err)
	}
	saved, _ := s.Get(task.ID)
	without := saved
	without.CodexLaunchNotice = nil
	if !reflect.DeepEqual(task, without) {
		t.Fatal("notice consumed/changed run", task, saved)
	}
	for _, run := range []string{task.RunID, "stale-run", ""} {
		if _, err = s.NoteCodexMissing(task.ID, run); !errors.Is(err, ErrConflict) {
			t.Fatal(err)
		}
		after, _ := s.Get(task.ID)
		if !reflect.DeepEqual(saved, after) {
			t.Fatal("repeated/stale write dirtied task", after)
		}
	}
	claimed, err := s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture"})
	if err != nil || claimed.CodexLaunchNotice != nil || claimed.Status != "working" || len(claimed.Events) != 2 || claimed.Events[1].Kind != "codex-start:" {
		t.Fatal(err, claimed)
	}
	if _, err = s.NoteCodexMissing(task.ID, task.RunID); !errors.Is(err, ErrConflict) {
		t.Fatal("late check accepted", err)
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(claimed, after) {
		t.Fatal("late check dirtied claim", after)
	}
}

func TestCodexMissingNoticeRejectsNonFreshOrOtherRun(t *testing.T) {
	for _, mode := range []string{"stale", "manual", "claimed", "synthetic"} {
		t.Run(mode, func(t *testing.T) {
			s, err := Open(filepath.Join(t.TempDir(), "guard.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			task, err := s.Create(CreateInput{Title: "Fixture", Goal: "Guard", Origin: "fixture"})
			if err != nil {
				t.Fatal(err)
			}
			run := task.RunID
			switch mode {
			case "stale":
				run = "old-run"
			case "manual":
				_, err = s.Apply(task.ID, "reports", Input{RunID: run, Kind: "progress", Message: "Manual", Origin: "fixture"})
			case "claimed":
				_, err = s.Apply(task.ID, "codex-start", Input{RunID: run, Origin: "fixture"})
			case "synthetic":
				_, err = s.db.Exec(`UPDATE tasks SET data=json_set(data,'$.source','synthetic') WHERE id=?`, task.ID)
			}
			if err != nil {
				t.Fatal(err)
			}
			before, _ := s.Get(task.ID)
			if _, err = s.NoteCodexMissing(task.ID, run); !errors.Is(err, ErrConflict) {
				t.Fatal(err)
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("rejected check dirtied task", after)
			}
		})
	}
}
