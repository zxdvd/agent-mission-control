package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"
)

// FollowUpInput is a new instruction about one exact delivered report. RequestID
// is supplied once by the client and must be reused verbatim after a lost receipt.
type FollowUpInput struct {
	RequestID     string `json:"request_id"`
	RunID         string `json:"run_id"`
	ReportEventID string `json:"report_event_id"`
	Kind          string `json:"kind"`
	Message       string `json:"message"`
}

// FollowUpSnapshot is immutable context, not a replacement task or report. Goal
// also carries the original task scope; there is no separate task scope field.
// Report.Message is the exact report summary, not a truncated display summary.
type FollowUpSnapshot struct {
	Title    string     `json:"title"`
	Goal     string     `json:"goal"`
	Report   Event      `json:"report"`
	Evidence []Evidence `json:"evidence"`
}

// FollowUp is independent from task JSON, acceptance, review, and lifecycle.
// ClaimID is an ownership capability returned only by a successful one-shot
// claim, never by browser-facing list/submit reads or JSON serialization.
type FollowUp struct {
	RequestID     string           `json:"request_id"`
	TaskID        string           `json:"task_id"`
	RunID         string           `json:"run_id"`
	ReportEventID string           `json:"report_event_id"`
	Kind          string           `json:"kind"`
	Message       string           `json:"message"`
	State         string           `json:"state"`
	Snapshot      FollowUpSnapshot `json:"snapshot"`
	ClaimID       string           `json:"-"`
	Reply         string           `json:"reply,omitempty"`
	CreatedAt     string           `json:"created_at"`
	ClaimedAt     string           `json:"claimed_at,omitempty"`
	FinishedAt    string           `json:"finished_at,omitempty"`
}

// ErrInvalidFollowUp identifies safe input validation errors for HTTP 400.
var ErrInvalidFollowUp = errors.New("invalid follow-up")

func (s *Store) initFollowUps() error {
	if _, err := s.db.Exec(`PRAGMA busy_timeout=5000`); err != nil {
		return err
	}
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS followups (
 task_id TEXT NOT NULL, request_id TEXT NOT NULL, state TEXT NOT NULL,
 claim_id TEXT NOT NULL DEFAULT '', data TEXT NOT NULL,
 PRIMARY KEY(task_id, request_id),
 CHECK(state IN ('pending','running','completed','blocked','uncertain'))
 );
 CREATE UNIQUE INDEX IF NOT EXISTS followups_one_active ON followups(task_id)
 WHERE state IN ('pending','running');`)
	return err
}

// Acquire the SQLite writer reservation before reading eligibility or duplicates.
// This also serializes independent Store handles without a read-to-write upgrade
// race. The statement touches no rows, including original task records.
func (s *Store) beginFollowUpMutation() (*sql.Tx, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(`UPDATE followups SET state=state WHERE 0`); err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

var followUpRequestID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func validFollowUpInput(in FollowUpInput) bool {
	return followUpRequestID.MatchString(in.RequestID) && strings.TrimSpace(in.RunID) != "" && strings.TrimSpace(in.ReportEventID) != "" &&
		(in.Kind == "explain" || in.Kind == "adjust") && utf8.ValidString(in.Message) && strings.TrimSpace(in.Message) != "" && utf8.RuneCountInString(in.Message) <= 8000
}

func sameFollowUpInput(f FollowUp, in FollowUpInput) bool {
	return f.RequestID == in.RequestID && f.RunID == in.RunID && f.ReportEventID == in.ReportEventID && f.Kind == in.Kind && f.Message == in.Message
}

func readFollowUp(tx *sql.Tx, taskID, requestID string) (FollowUp, string, error) {
	var data, claim string
	var f FollowUp
	err := tx.QueryRow(`SELECT data,claim_id FROM followups WHERE task_id=? AND request_id=?`, taskID, requestID).Scan(&data, &claim)
	if err == nil {
		err = json.Unmarshal([]byte(data), &f)
	}
	return f, claim, err
}

// ListFollowUps returns immutable request context and receipt states, never the
// claim capability. Even an unknown task has a predictable not-found result.
func (s *Store) ListFollowUps(taskID string) ([]FollowUp, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var exists string
	if err = tx.QueryRow(`SELECT id FROM tasks WHERE id=?`, taskID).Scan(&exists); err != nil {
		return nil, err
	}
	rows, err := tx.Query(`SELECT data FROM followups WHERE task_id=? ORDER BY rowid`, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FollowUp{}
	for rows.Next() {
		var data string
		var f FollowUp
		if err = rows.Scan(&data); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(data), &f); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// SubmitFollowUp stores an exact, bounded snapshot transactionally. The duplicate
// check precedes current-report checks: replaying an identical submission after
// a new report or completion retrieves the original receipt and never requeues.
func (s *Store) SubmitFollowUp(taskID string, in FollowUpInput) (FollowUp, error) {
	if !validFollowUpInput(in) {
		return FollowUp{}, fmt.Errorf("%w: request_id, run_id, report_event_id, explain/adjust kind, and a nonblank UTF-8 message of at most 8000 characters are required", ErrInvalidFollowUp)
	}
	tx, err := s.beginFollowUpMutation()
	if err != nil {
		return FollowUp{}, err
	}
	defer tx.Rollback()
	existing, _, err := readFollowUp(tx, taskID, in.RequestID)
	if err == nil {
		if !sameFollowUpInput(existing, in) {
			return FollowUp{}, fmt.Errorf("%w: request_id already names a different follow-up payload", ErrConflict)
		}
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return FollowUp{}, err
	}
	var data string
	var task Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, taskID).Scan(&data); err != nil {
		return FollowUp{}, err
	}
	if err = json.Unmarshal([]byte(data), &task); err != nil {
		return FollowUp{}, err
	}
	if managed, checkErr := hasManagedOwner(tx, taskID, task.RunID); checkErr != nil {
		return FollowUp{}, checkErr
	} else if managed {
		return FollowUp{}, fmt.Errorf("%w: use the original managed Codex thread on this card", ErrConflict)
	}
	if task.ID != taskID || task.ProjectID != "local" || in.RunID != task.RunID || in.ReportEventID != CurrentReadyReportID(task) {
		return FollowUp{}, fmt.Errorf("%w: follow-up requires the unchanged current local evidence-backed ready report", ErrConflict)
	}
	var total int
	if err = tx.QueryRow(`SELECT count(*) FROM followups WHERE task_id=?`, taskID).Scan(&total); err != nil {
		return FollowUp{}, err
	}
	if total >= 50 {
		return FollowUp{}, fmt.Errorf("%w: follow-up history limit of 50 reached; no records were removed", ErrConflict)
	}
	var active int
	if err = tx.QueryRow(`SELECT count(*) FROM followups WHERE task_id=? AND state IN ('pending','running')`, taskID).Scan(&active); err != nil {
		return FollowUp{}, err
	}
	if active != 0 {
		return FollowUp{}, fmt.Errorf("%w: this task already has a pending or running follow-up", ErrConflict)
	}
	var report Event
	for _, event := range task.Events {
		if event.ID == in.ReportEventID && event.RunID == in.RunID {
			report = event
			break
		}
	}
	f := FollowUp{RequestID: in.RequestID, TaskID: taskID, RunID: in.RunID, ReportEventID: in.ReportEventID, Kind: in.Kind, Message: in.Message, State: "pending", CreatedAt: now(), Snapshot: FollowUpSnapshot{Title: task.Title, Goal: task.Goal, Report: report, Evidence: task.Evidence}}
	encoded, err := json.Marshal(f)
	if err != nil {
		return FollowUp{}, err
	}
	if len(encoded) > maxTaskReadbackBytes {
		return FollowUp{}, fmt.Errorf("%w: follow-up snapshot exceeds 1 MiB; no request or partial snapshot was saved", ErrInvalidFollowUp)
	}
	if _, err = tx.Exec(`INSERT INTO followups(task_id,request_id,state,data) VALUES(?,?,?,?)`, taskID, in.RequestID, f.State, string(encoded)); err != nil {
		return FollowUp{}, err
	}
	return f, tx.Commit()
}

// ClaimFollowUp is an explicit one-shot dispatch boundary, not a queue drain.
// A lost claim receipt or process restart cannot reacquire a running request.
// A stale queued report is atomically claimed and blocked with that exact claim
// identity, without dispatch; the returned conflict explains non-acceptance.
func (s *Store) ClaimFollowUp(taskID, requestID string) (FollowUp, error) {
	tx, err := s.beginFollowUpMutation()
	if err != nil {
		return FollowUp{}, err
	}
	defer tx.Rollback()
	f, _, err := readFollowUp(tx, taskID, requestID)
	if err != nil {
		return FollowUp{}, err
	}
	if f.State != "pending" {
		return FollowUp{}, fmt.Errorf("%w: follow-up is not pending; running or finished work cannot be replayed", ErrConflict)
	}
	var data string
	var task Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, taskID).Scan(&data); err != nil {
		return FollowUp{}, err
	}
	if err = json.Unmarshal([]byte(data), &task); err != nil {
		return FollowUp{}, err
	}
	var random [32]byte
	if _, err = rand.Read(random[:]); err != nil {
		return FollowUp{}, err
	}
	claim := fmt.Sprintf("claim-%x", random)
	f.State, f.ClaimedAt = "running", now()
	if err = writeFollowUp(tx, f, claim, "pending", ""); err != nil {
		return FollowUp{}, err
	}
	stale := task.ID != taskID || task.ProjectID != "local" || task.RunID != f.RunID || CurrentReadyReportID(task) != f.ReportEventID || task.Title != f.Snapshot.Title || task.Goal != f.Snapshot.Goal || !reflect.DeepEqual(task.Evidence, f.Snapshot.Evidence)
	if stale {
		f.State, f.FinishedAt, f.Reply = "blocked", now(), "The pinned delivery changed before this follow-up was claimed. Nothing was dispatched; submit a new request for the current report."
		if err = writeFollowUp(tx, f, claim, "running", claim); err != nil {
			return FollowUp{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return FollowUp{}, err
	}
	if stale {
		return f, fmt.Errorf("%w: pinned report changed; follow-up recorded as blocked without dispatch", ErrConflict)
	}
	f.ClaimID = claim
	return f, nil
}

func writeFollowUp(tx *sql.Tx, f FollowUp, claim, expectedState, expectedClaim string) error {
	encoded, err := json.Marshal(f)
	if err != nil {
		return err
	}
	result, err := tx.Exec(`UPDATE followups SET state=?,claim_id=?,data=? WHERE task_id=? AND request_id=? AND state=? AND claim_id=?`, f.State, claim, string(encoded), f.TaskID, f.RequestID, expectedState, expectedClaim)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count != 1 {
		err = fmt.Errorf("%w: follow-up claim changed", ErrConflict)
	}
	return err
}

// CompleteFollowUp records only a reply, never report evidence or acceptance.
// The exact original owner may retry the same terminal receipt, but cannot revise
// it, complete another claim, or resurrect a finished or uncertain execution.
func (s *Store) CompleteFollowUp(taskID, requestID, claimID, state, reply string) (FollowUp, error) {
	if claimID == "" || (state != "completed" && state != "blocked" && state != "uncertain") || !utf8.ValidString(reply) || strings.TrimSpace(reply) == "" || len(reply) > 128<<10 {
		return FollowUp{}, fmt.Errorf("%w: exact claim identity, completed/blocked/uncertain state, and a nonblank UTF-8 reply of at most 128 KiB are required", ErrInvalidFollowUp)
	}
	tx, err := s.beginFollowUpMutation()
	if err != nil {
		return FollowUp{}, err
	}
	defer tx.Rollback()
	f, claim, err := readFollowUp(tx, taskID, requestID)
	if err != nil {
		return FollowUp{}, err
	}
	if claim != claimID {
		return FollowUp{}, fmt.Errorf("%w: follow-up completion requires the exact claim owner", ErrConflict)
	}
	if f.State != "running" {
		if f.State == state && f.Reply == reply {
			return f, nil
		}
		return FollowUp{}, fmt.Errorf("%w: follow-up is already final or was never claimed", ErrConflict)
	}
	f.State, f.Reply, f.FinishedAt = state, reply, now()
	if err = writeFollowUp(tx, f, claim, "running", claim); err != nil {
		return FollowUp{}, err
	}
	return f, tx.Commit()
}
