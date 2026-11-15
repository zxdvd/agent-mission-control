package store

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func setup(t *testing.T) *Store {
	t.Helper()
	s, e := Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Seed(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s
}
func TestDecisionReceiptAndExactRun(t *testing.T) {
	s := setup(t)
	before, _ := s.Get("t2")
	_, e := s.Apply("t2", "decisions", Input{RunID: "stale", Answer: "只修复重复查询"})
	if !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	got, e := s.Apply("t2", "decisions", Input{RunID: before.RunID, Answer: before.Decision.Options[0]})
	if e != nil {
		t.Fatal(e)
	}
	if got.Status != "needs_decision" || got.Commands[0].Status != "recorded" || got.ObservedAt != before.ObservedAt {
		t.Fatal("record is not delivery", got)
	}
	if _, e = s.Apply("t2", "decisions", Input{RunID: before.RunID, Answer: before.Decision.Options[0]}); !errors.Is(e, ErrConflict) {
		t.Fatal("duplicate", e)
	}
	if _, e = s.Apply("t2", "reports", Input{RunID: before.RunID, Kind: "receipt", CommandID: "unknown"}); e == nil {
		t.Fatal("bad receipt accepted")
	}
	got, e = s.Apply("t2", "reports", Input{RunID: before.RunID, Kind: "receipt", CommandID: got.Commands[0].ID})
	if e != nil || got.Status != "needs_decision" || got.Commands[0].Status != "acknowledged" {
		t.Fatal(got, e)
	}
}
func TestFollowUpOnceAndEvidence(t *testing.T) {
	s := setup(t)
	got, e := s.Apply("t3", "follow-up", Input{RunID: "t3-run-1"})
	if e != nil || got.FollowUpCount != 1 || got.Status != "needs_evidence" {
		t.Fatal(got, e)
	}
	_, e = s.Apply("t3", "follow-up", Input{RunID: "t3-run-1"})
	if !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	got, e = s.Apply("t1", "reports", Input{RunID: "t1-run-1", Kind: "ready", Message: "turn ended"})
	if e != nil || got.Status != "needs_evidence" {
		t.Fatal(got, e)
	}
	_, e = s.Apply("t1", "reports", Input{RunID: "t1-run-1", Kind: "completed", Message: "done"})
	if e == nil {
		t.Fatal("completion without evidence")
	}
	got, e = s.Apply("t1", "reports", Input{RunID: "t1-run-1", Kind: "ready", Message: "report", Evidence: []Evidence{{Label: "test", URL: "https://example.test/result"}}})
	if e != nil || got.Status != "ready" {
		t.Fatal(got, e)
	}
}
func TestPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "persist.db")
	s, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	s.Seed()
	_, e = s.Apply("t3", "follow-up", Input{RunID: "t3-run-1"})
	if e != nil {
		t.Fatal(e)
	}
	s.Close()
	s, e = Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.Seed()
	got, e := s.Get("t3")
	if e != nil || got.FollowUpCount != 1 || len(got.Commands) != 1 {
		t.Fatal(got, e)
	}
}

func TestLateReceiptDoesNotOverwriteNewReport(t *testing.T) {
	s := setup(t)
	got, e := s.Apply("t2", "decisions", Input{RunID: "t2-run-1", Answer: "只修复重复查询"})
	if e != nil {
		t.Fatal(e)
	}
	cmd := got.Commands[0].ID
	got, e = s.Apply("t2", "reports", Input{RunID: got.RunID, Kind: "needs_decision", Message: "new blocker", Decision: &Decision{"new question", []string{"a", "b"}}})
	if e != nil {
		t.Fatal(e)
	}
	got, e = s.Apply("t2", "reports", Input{RunID: got.RunID, Kind: "receipt", CommandID: cmd})
	if e != nil || got.Status != "needs_decision" || got.Decision.Question != "new question" {
		t.Fatal(got, e)
	}
}

func TestReportRequiresUsableEvidence(t *testing.T) {
	cases := []struct {
		name     string
		evidence []Evidence
		usable   bool
	}{
		{"missing", nil, false},
		{"empty object", []Evidence{{}}, false},
		{"whitespace", []Evidence{{Label: " \t", URL: " \n", Excerpt: " \t\n"}}, false},
		{"label alone", []Evidence{{Label: "tests passed"}}, false},
		{"unlabeled URL", []Evidence{{URL: "https://example.test/result"}}, false},
		{"local path", []Evidence{{Label: "test log", URL: "file:///tmp/result.txt"}}, false},
		{"fragment", []Evidence{{Label: "reference", URL: "#evidence"}}, false},
		{"unsafe scheme", []Evidence{{Label: "test log", URL: "javascript:alert(1)"}}, false},
		{"missing host", []Evidence{{Label: "test log", URL: "https:///result"}}, false},
		{"embedded newline", []Evidence{{Label: "test log", URL: "https://example.test/\nresult"}}, false},
		{"HTTP link", []Evidence{{Label: "test log", URL: "http://example.test/result"}}, true},
		{"HTTPS link", []Evidence{{Label: " test log ", URL: " https://example.test/result "}}, true},
		{"excerpt only", []Evidence{{Excerpt: "8 tests passed; whitespace regression included."}}, true},
		{"local reference plus excerpt", []Evidence{{Label: "fixture test log", URL: "file:///not/read/result.txt", Excerpt: "Before: 1/7 failed. After: 8/8 passed.", Origin: "isolated fixture executor"}}, true},
		{"one usable item", []Evidence{{}, {Excerpt: "8 tests passed."}}, true},
	}
	for _, tc := range cases {
		for _, kind := range []string{"ready", "completed"} {
			t.Run(tc.name+"/"+kind, func(t *testing.T) {
				s := setup(t)
				before, _ := s.Get("t1")
				got, err := s.Apply("t1", "reports", Input{RunID: before.RunID, Kind: kind, Message: "executor report", Evidence: tc.evidence})
				if !tc.usable && kind == "completed" {
					if err == nil {
						t.Fatal("accepted unusable completion", got)
					}
					persisted, _ := s.Get("t1")
					if persisted.Status != before.Status || len(persisted.Events) != len(before.Events) {
						t.Fatal("rejected report was persisted", persisted)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				want := "needs_evidence"
				if tc.usable {
					want = "ready"
				}
				if got.Status != want {
					t.Fatalf("status = %q, want %q", got.Status, want)
				}
				persisted, err := s.Get("t1")
				if err != nil || persisted.Status != want {
					t.Fatal(persisted, err)
				}
				if tc.usable && len(tc.evidence) > 0 && (persisted.Evidence[0].Excerpt != tc.evidence[0].Excerpt || persisted.Evidence[0].Origin != tc.evidence[0].Origin) {
					t.Fatal("lost excerpt or origin", persisted.Evidence)
				}
			})
		}
	}
}

func TestExcerptBoundAndSeedCompatibility(t *testing.T) {
	s := setup(t)
	for _, kind := range []string{"ready", "completed"} {
		if _, err := s.Apply("t1", "reports", Input{RunID: "t1-run-1", Kind: kind, Message: "report", Evidence: []Evidence{{Excerpt: strings.Repeat("测", 2001)}}}); err == nil {
			t.Fatal("accepted oversized excerpt")
		}
	}
	got, err := s.Apply("t1", "reports", Input{RunID: "t1-run-1", Kind: "ready", Message: "report", Evidence: []Evidence{{Excerpt: strings.Repeat("测", 2000)}}})
	if err != nil || got.Status != "ready" {
		t.Fatal(got, err)
	}
	seed, err := s.Get("t4")
	if err != nil || seed.Status != "ready" || seed.Evidence[0].URL != "#synthetic-evidence" || seed.Evidence[0].Origin != "合成演示" {
		t.Fatal("synthetic seed changed incompatibly", seed, err)
	}
}
