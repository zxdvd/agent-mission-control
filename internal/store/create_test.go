package store

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestLocalCreateAndReportPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "local.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	items, err := s.List()
	if err != nil || len(items) != 0 {
		t.Fatal(items, err)
	}
	first, err := s.Create(CreateInput{Title: "  Fix whitespace search  ", Goal: "Fixture only; add regression and test", Origin: "Owner-created disposable fixture"})
	if err != nil {
		t.Fatal(err)
	}
	if first.Source != "local" || first.ProjectID != "local" || first.Status != "not_started" || first.ObservedAt != "" || len(first.Commands) != 0 || first.Title != "Fix whitespace search" {
		t.Fatal(first)
	}
	other, err := s.Create(CreateInput{Title: "Other work", Goal: "Do not touch", Origin: "Owner"})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == other.ID || first.RunID == other.RunID {
		t.Fatal("identities reused")
	}
	if _, err = s.Apply(first.ID, "reports", Input{RunID: other.RunID, Kind: "progress", Message: "wrong", Origin: "CLI"}); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	if _, err = s.Apply(first.ID, "reports", Input{RunID: first.RunID, Kind: "progress", Message: "no source"}); err == nil {
		t.Fatal("origin required")
	}
	next, err := s.Apply(first.ID, "reports", Input{RunID: first.RunID, Kind: "ready", Message: "Fixture: 8 passed", Origin: "Manual relay; not workbench dispatched", Evidence: []Evidence{{Excerpt: "Before: 7 tests, 1 failed. After: 8 passed.", Origin: "Fixture executor"}}})
	if err != nil || next.Status != "ready" || next.Source != first.Source || next.Origin != first.Origin || next.Events[len(next.Events)-1].Origin != "Manual relay; not workbench dispatched" {
		t.Fatal(next, err)
	}
	untouched, _ := s.Get(other.ID)
	if untouched.Status != "not_started" {
		t.Fatal(untouched)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	persisted, err := s.Get(first.ID)
	if err != nil || persisted.RunID != first.RunID || persisted.Evidence[0].Origin != "Fixture executor" || persisted.Status != "ready" {
		t.Fatal(persisted, err)
	}
	if err = s.Seed(); err == nil {
		t.Fatal("mixed demo and local")
	}
}
func TestCreateValidationAndSeparateDemo(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	for _, in := range []CreateInput{{}, {Title: "x", Goal: "x"}, {Title: " ", Goal: "x", Origin: "owner"}, {Title: strings.Repeat("a", 161), Goal: "x", Origin: "owner"}, {Title: "x", Goal: strings.Repeat("测", 2001), Origin: "owner"}, {Title: "x", Goal: "x", Origin: strings.Repeat("a", 301)}} {
		if _, err := s.Create(in); err == nil {
			t.Fatal("accepted invalid", in)
		}
	}
	if err = s.Seed(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Create(CreateInput{Title: "Real work", Goal: "No mixing", Origin: "Owner"}); err == nil {
		t.Fatal("mixed local and demo")
	}
}
