package store

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestProjectNameCreateReopenAndNoInference(t *testing.T) {
	path := filepath.Join(t.TempDir(), "project.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	named, err := s.Create(CreateInput{Title: "Work", Goal: "Explicit scope", Origin: "fixture", ProjectName: "  MCP relay  "})
	if err != nil {
		t.Fatal(err)
	}
	if named.ProjectName != "MCP relay" || named.ProjectID != "local" || named.Source != "local" {
		t.Fatal("display name changed identity")
	}
	unnamed, err := s.Create(CreateInput{Title: "AMC relay Workbench", Goal: "Do not infer display metadata", Origin: "MCP"})
	if err != nil || unnamed.ProjectName != "" {
		t.Fatal("inferred project name", err)
	}
	maximum := strings.Repeat("🙂", 60)
	if _, err = s.Create(CreateInput{Title: "Boundary", Goal: "Sixty runes", Origin: "fixture", ProjectName: maximum}); err != nil {
		t.Fatal("valid rune boundary rejected", err)
	}
	for _, name := range []string{strings.Repeat("项", 61), string([]byte{0xff})} {
		if _, err = s.Create(CreateInput{Title: "Rejected", Goal: "No mutation", Origin: "fixture", ProjectName: name}); err == nil {
			t.Fatal("invalid project name accepted")
		}
	}
	if err = s.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	saved, err := reopened.Get(named.ID)
	if err != nil || !reflect.DeepEqual(named, saved) {
		t.Fatal("project name not durable", err)
	}
}

func TestProjectNameRenameClearPreserveAllOtherStateAndLaterReport(t *testing.T) {
	s, task, _ := readyReviewFixture(t)
	task = nextEvidenceReport(t, s, task, "second", []Evidence{{Excerpt: "Current declared evidence"}})
	task, err := s.ReviewDelivery(task.ID, task.RunID, CurrentReadyReportID(task))
	if err != nil {
		t.Fatal(err)
	}
	task, err = s.SetLocalFollowUp(task.ID, task.RunID, CurrentReadyReportID(task), "end", "")
	if err != nil {
		t.Fatal(err)
	}
	if task.PreviousDeliveryEvidence == nil {
		t.Fatal("fixture missing previous evidence")
	}
	renamed, err := s.SetProjectName(task.ID, "  Workbench  ")
	if err != nil {
		t.Fatal(err)
	}
	expected := task
	expected.ProjectName = "Workbench"
	if !reflect.DeepEqual(expected, renamed) {
		t.Fatal("metadata rename changed timestamps/events/lifecycle/evidence")
	}
	duplicate, err := s.SetProjectName(task.ID, "Workbench")
	if err != nil || !reflect.DeepEqual(renamed, duplicate) {
		t.Fatal("repeated rename changed state", err)
	}
	cleared, err := s.SetProjectName(task.ID, "")
	if err != nil || !reflect.DeepEqual(task, cleared) {
		t.Fatal("clear changed other state", err)
	}
	renamed, err = s.SetProjectName(task.ID, "AMC")
	if err != nil {
		t.Fatal(err)
	}
	latest := nextEvidenceReport(t, s, renamed, "third", []Evidence{{Excerpt: "Later formal result"}})
	if latest.ProjectName != "AMC" || latest.ProjectID != task.ProjectID || latest.RunID != task.RunID || latest.Source != task.Source {
		t.Fatal("later report lost label or changed identity")
	}
	before := latest
	if _, err = s.SetProjectName(task.ID, strings.Repeat("a", 61)); err == nil {
		t.Fatal("invalid rename accepted")
	}
	after, _ := s.Get(task.ID)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("rejected rename mutated task")
	}
}

func TestProjectNameCannotChangeDemoOrInterfereWithExactDecision(t *testing.T) {
	s, task, binding := freshBoundDecision(t)
	renamed, err := s.SetProjectName(task.ID, "MCP relay")
	if err != nil {
		t.Fatal(err)
	}
	expected := task
	expected.ProjectName = "MCP relay"
	if !reflect.DeepEqual(expected, renamed) {
		t.Fatal("rename changed exact decision/binding")
	}
	answer, err := s.Apply(task.ID, "decisions", Input{RunID: task.RunID, Decision: task.Decision, Answer: task.Decision.Options[0]})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "receipt", Origin: "fixture", CommandID: answer.Commands[0].ID, CodexBinding: binding})
	if err != nil || receipt.ProjectName != "MCP relay" || !SameCodexBinding(receipt.CodexBinding, binding) {
		t.Fatal("label interfered with receipt", err)
	}
	demo, err := Open(filepath.Join(t.TempDir(), "demo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer demo.Close()
	if err = demo.Seed(); err != nil {
		t.Fatal(err)
	}
	before, _ := demo.Get("t4")
	if _, err = demo.SetProjectName("t4", "Not local"); !errors.Is(err, ErrConflict) {
		t.Fatal("demo label allowed", err)
	}
	after, _ := demo.Get("t4")
	if !reflect.DeepEqual(before, after) {
		t.Fatal("demo mutated")
	}
}

func TestProjectNameTransactionDoesNotLoseConcurrentReport(t *testing.T) {
	s, task, _ := readyReviewFixture(t)
	done := make(chan error, 2)
	go func() { _, err := s.SetProjectName(task.ID, "Workbench"); done <- err }()
	go func() {
		_, err := s.Apply(task.ID, "reports", Input{RunID: task.RunID, Kind: "ready", Message: "Concurrent formal report", Origin: "fixture", Evidence: []Evidence{{Excerpt: "Concurrent declared result"}}})
		done <- err
	}()
	for i := 0; i < 2; i++ {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
	after, err := s.Get(task.ID)
	if err != nil || after.ProjectName != "Workbench" || after.ProjectID != task.ProjectID || after.RunID != task.RunID || after.Status != "ready" || after.Summary != "Concurrent formal report" || after.Evidence[0].Excerpt != "Concurrent declared result" || len(after.Events) != len(task.Events)+1 {
		t.Fatal("metadata/report transaction lost a write", err)
	}
}

func TestProjectNameRenameBetweenBriefReadAndClaimDoesNotChangeScope(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "brief-label.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	task, err := s.Create(CreateInput{Title: "Exact saved title", Goal: "Exact saved scope", Origin: "fixture"})
	if err != nil {
		t.Fatal(err)
	}
	expected := &TaskBriefExpectation{Title: task.Title, Goal: task.Goal}
	if _, err = s.SetProjectName(task.ID, "AMC"); err != nil {
		t.Fatal(err)
	}
	claimed, err := s.Apply(task.ID, "codex-start", Input{RunID: task.RunID, Origin: "fixture", ExpectedTaskBrief: expected})
	if err != nil || claimed.ProjectName != "AMC" || claimed.ProjectID != task.ProjectID || claimed.RunID != task.RunID || claimed.Title != task.Title || claimed.Goal != task.Goal || claimed.Status != "working" || len(claimed.Events) != 2 {
		t.Fatal("display rename altered task brief claim or execution identity", err)
	}
}
