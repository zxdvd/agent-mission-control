package store

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func visibilityFixture(t *testing.T, blocked bool) (*Store, Task, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "visibility.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	task, err := s.Create(CreateInput{Title: "Visibility fixture", Goal: "Only local list membership", Origin: "test owner"})
	if err != nil {
		t.Fatal(err)
	}
	if blocked {
		task, err = s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "failed", Message: "Exact blocked summary: 测试\n", Origin: "fixture reporter", Evidence: []Evidence{{Label: "Declared evidence", URL: "https://example.test/raw?q=a%20b", Excerpt: " Exact evidence\n\t保留 ", Origin: "Reporter, not verified"}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	return s, task, path
}

func visibilityInput(task Task, op string) LocalVisibilityInput {
	revision := ""
	if task.LocalVisibility != nil {
		revision = task.LocalVisibility.RecordedAt
	}
	return LocalVisibilityInput{RunID: task.RunID, Operation: op, ExpectedRecordedAt: revision, LastReportEventID: LastSubstantiveReportID(task), LaunchNoticeRecordedAt: launchNoticeRecordedAt(task)}
}

func TestLocalVisibilityDurableReversibleOnlyMarker(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		t.Run(map[bool]string{false: "not_started", true: "blocked"}[blocked], func(t *testing.T) {
			s, task, path := visibilityFixture(t, blocked)
			hidden, err := s.SetLocalVisibility(task.ID, visibilityInput(task, "hide"))
			if err != nil || hidden.LocalVisibility == nil || hidden.LocalVisibility.State != "hidden" {
				t.Fatal(err, hidden)
			}
			if _, err = time.Parse(time.RFC3339Nano, hidden.LocalVisibility.RecordedAt); err != nil {
				t.Fatal(err)
			}
			copy := hidden
			copy.LocalVisibility = nil
			if !reflect.DeepEqual(copy, task) {
				t.Fatal("hide changed lifecycle, evidence or history")
			}
			reopened, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			loaded, err := reopened.Get(task.ID)
			if err != nil || !reflect.DeepEqual(loaded, hidden) {
				t.Fatal("not durable", err)
			}
			// Repeating against the currently observed revision is a no-op.
			same, err := s.SetLocalVisibility(task.ID, visibilityInput(hidden, "hide"))
			if err != nil || !reflect.DeepEqual(same, hidden) {
				t.Fatal("repeat changed marker", err)
			}
			restored, err := s.SetLocalVisibility(task.ID, visibilityInput(hidden, "restore"))
			if err != nil || restored.LocalVisibility.State != "visible" {
				t.Fatal(err, restored)
			}
			copy = restored
			copy.LocalVisibility = nil
			if !reflect.DeepEqual(copy, task) {
				t.Fatal("restore changed exact task content")
			}
			for _, in := range []LocalVisibilityInput{visibilityInput(task, "hide"), visibilityInput(hidden, "restore"), {RunID: "old-run", Operation: "hide", LastReportEventID: LastSubstantiveReportID(restored), ExpectedRecordedAt: restored.LocalVisibility.RecordedAt}} {
				if _, err = s.SetLocalVisibility(task.ID, in); !errors.Is(err, ErrConflict) {
					t.Fatal("stale request accepted", err)
				}
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(restored, after) {
				t.Fatal("stale toggle changed state")
			}
		})
	}
}

func TestLocalVisibilityNewSubstantiveReportUnhides(t *testing.T) {
	for _, kind := range []string{"progress", "failed", "ready", "completed", "needs_decision"} {
		t.Run(kind, func(t *testing.T) {
			s, task, _ := visibilityFixture(t, true)
			hidden, err := s.SetLocalVisibility(task.ID, visibilityInput(task, "hide"))
			if err != nil {
				t.Fatal(err)
			}
			in := Input{RunID: task.RunID, Kind: kind, Message: "New exact report", Origin: "fixture", Evidence: []Evidence{{Excerpt: "New declared evidence"}}}
			if kind == "needs_decision" {
				in.Decision = &Decision{Question: "Next?", Options: []string{"First", "Second"}}
			}
			next, err := s.Apply(task.ID, "reports", in)
			if err != nil {
				t.Fatal(err)
			}
			if next.LocalVisibility != nil || LastSubstantiveReportID(next) == LastSubstantiveReportID(hidden) {
				t.Fatal("new report did not invalidate hidden state")
			}
			if _, err = s.SetLocalVisibility(task.ID, visibilityInput(hidden, "restore")); !errors.Is(err, ErrConflict) {
				t.Fatal("old report accepted", err)
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(next, after) {
				t.Fatal("old action changed new report")
			}
		})
	}
}

func TestLocalVisibilityReceiptAndMetadataDoNotUnhide(t *testing.T) {
	s, task, _ := visibilityFixture(t, true)
	// Provide a same-run command as receipt bookkeeping, without reporting content.
	command := Command{ID: "fixture-command", Kind: "follow_up", RunID: task.RunID, Status: "recorded"}
	task.Commands = append(task.Commands, command)
	data, _ := json.Marshal(task)
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), task.ID); err != nil {
		t.Fatal(err)
	}
	hidden, err := s.SetLocalVisibility(task.ID, visibilityInput(task, "hide"))
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "receipt", Origin: "fixture", CommandID: command.ID})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(receipt.LocalVisibility, hidden.LocalVisibility) || LastSubstantiveReportID(receipt) != LastSubstantiveReportID(hidden) || !reflect.DeepEqual(receipt.Evidence, hidden.Evidence) {
		t.Fatal("receipt changed content anchor or visibility")
	}
	renamed, err := s.SetProjectName(task.ID, "Display-only label")
	if err != nil || !reflect.DeepEqual(renamed.LocalVisibility, hidden.LocalVisibility) {
		t.Fatal("metadata unhid task", err)
	}
}

func TestLocalVisibilityRejectsOtherSourcesStatusesAndWrongAnchors(t *testing.T) {
	for _, mode := range []string{"synthetic", "demo", "working", "ready", "needs_decision", "needs_evidence", "completed", "wrong-report", "wrong-run", "unknown-operation", "open-decision"} {
		t.Run(mode, func(t *testing.T) {
			s, task, _ := visibilityFixture(t, true)
			in := visibilityInput(task, "hide")
			switch mode {
			case "synthetic":
				task.Source = "synthetic"
			case "demo":
				task.ProjectID = "demo"
			case "wrong-report":
				in.LastReportEventID = "older-report"
			case "wrong-run":
				in.RunID = "old-run"
			case "open-decision":
				task.Decision = &Decision{Question: "Unresolved?", Options: []string{"First", "Second"}}
			case "unknown-operation":
				in.Operation = "complete"
			default:
				task.Status = mode
			}
			data, _ := json.Marshal(task)
			if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), task.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SetLocalVisibility(task.ID, in); err == nil {
				t.Fatal("unsupported mutation accepted")
			}
			after, _ := s.Get(task.ID)
			if !reflect.DeepEqual(after, task) {
				t.Fatal("rejected action changed state")
			}
		})
	}
}

func TestLocalVisibilityNeverTrimsEvidenceForSize(t *testing.T) {
	s, task, _ := visibilityFixture(t, true)
	task.PreviousDeliveryEvidence = &PreviousDeliveryEvidence{RunID: task.RunID, ReportEventID: "exact-previous", Evidence: []Evidence{{Excerpt: "retain exactly"}}}
	task.Summary = ""
	data, _ := json.Marshal(task)
	// Fill precisely to the preexisting readback bound, leaving no marker room.
	task.Summary = strings.Repeat("x", maxTaskReadbackBytes-1-len(data))
	data, _ = json.Marshal(task)
	if len(data)+1 != maxTaskReadbackBytes {
		t.Fatal(len(data))
	}
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), task.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetLocalVisibility(task.ID, visibilityInput(task, "hide")); err == nil {
		t.Fatal("oversize marker accepted")
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(after, task) {
		t.Fatal("list mutation trimmed evidence")
	}
}

func TestLocalVisibilityLaunchDiagnosticRevivesAndGuardsStaleHide(t *testing.T) {
	s, task, path := visibilityFixture(t, false)
	hidden, err := s.SetLocalVisibility(task.ID, visibilityInput(task, "hide"))
	if err != nil {
		t.Fatal(err)
	}
	notice, err := s.NoteCodexMissing(task.ID, task.RunID)
	if err != nil {
		t.Fatal(err)
	}
	revived, err := s.Get(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if revived.LocalVisibility != nil || revived.CodexLaunchNotice == nil || revived.CodexLaunchNotice.RecordedAt != notice.RecordedAt {
		t.Fatal("startup diagnostic did not revive", revived)
	}
	copy := revived
	copy.CodexLaunchNotice = nil
	if !reflect.DeepEqual(copy, task) {
		t.Fatal("diagnostic changed lifecycle/evidence/history")
	}
	for _, in := range []LocalVisibilityInput{visibilityInput(task, "hide"), visibilityInput(hidden, "restore")} {
		if _, err = s.SetLocalVisibility(task.ID, in); !errors.Is(err, ErrConflict) {
			t.Fatal("stale startup version accepted", err)
		}
	}
	// Refresh permits hiding again, anchored to the newly observed diagnostic.
	next, err := s.SetLocalVisibility(task.ID, visibilityInput(revived, "hide"))
	if err != nil {
		t.Fatal(err)
	}
	if next.LocalVisibility.LaunchNoticeRecordedAt != notice.RecordedAt {
		t.Fatal("notice version not persisted", next.LocalVisibility)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	loaded, err := reopened.Get(task.ID)
	if err != nil || !reflect.DeepEqual(next, loaded) {
		t.Fatal("notice anchor not durable", err)
	}
	if _, err = s.NoteCodexMissing(task.ID, task.RunID); !errors.Is(err, ErrConflict) {
		t.Fatal("duplicate diagnostic accepted", err)
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(next, after) {
		t.Fatal("rejected diagnostic changed hidden state")
	}
	restored, err := s.SetLocalVisibility(task.ID, visibilityInput(next, "restore"))
	if err != nil || restored.LocalVisibility.State != "visible" {
		t.Fatal(err, restored)
	}
}

func TestLocalVisibilityPreservesUnknownLegacyRevisionAsVisible(t *testing.T) {
	s, task, _ := visibilityFixture(t, false)
	legacy := &LocalVisibility{RunID: task.RunID, Revision: "unknown-legacy-.45-version", State: "hidden", RecordedAt: now()}
	task.LocalVisibility = legacy
	data, _ := json.Marshal(task)
	if _, err := s.db.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), task.ID); err != nil {
		t.Fatal(err)
	}
	renamed, err := s.SetProjectName(task.ID, "Display label")
	if err != nil || !reflect.DeepEqual(renamed.LocalVisibility, legacy) {
		t.Fatal("ordinary write erased legacy revision", err)
	}
	// An unknown revision does not authorize a current hidden state or use of its timestamp.
	in := LocalVisibilityInput{RunID: task.RunID, Operation: "restore", ExpectedRecordedAt: legacy.RecordedAt}
	if _, err = s.SetLocalVisibility(task.ID, in); !errors.Is(err, ErrConflict) {
		t.Fatal("unknown legacy marker treated as current", err)
	}
	in.ExpectedRecordedAt = ""
	visible, err := s.SetLocalVisibility(task.ID, in)
	if err != nil || !reflect.DeepEqual(visible.LocalVisibility, legacy) {
		t.Fatal("unknown legacy marker should be visible no-op and preserved", err)
	}
}
