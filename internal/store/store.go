package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	_ "modernc.org/sqlite"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type Project struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Goal string `json:"goal"`
}
type Evidence struct {
	Label   string `json:"label"`
	URL     string `json:"url"`
	Excerpt string `json:"excerpt,omitempty"`
	Origin  string `json:"origin,omitempty"`
}

// Evidence is report content, not independent verification. Only HTTP(S) links
// are openable; local paths are never read. Inline excerpts are supplied by the
// reporter and bounded so review does not require opening an artifact.
const maxEvidenceExcerpt = 2000

func usableEvidence(items []Evidence) bool {
	for _, item := range items {
		if strings.TrimSpace(item.Excerpt) != "" {
			return true
		}
		if strings.TrimSpace(item.Label) == "" {
			continue
		}
		raw := strings.TrimSpace(item.URL)
		if strings.IndexFunc(raw, unicode.IsSpace) >= 0 {
			continue
		}
		u, err := url.Parse(raw)
		if err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" {
			return true
		}
	}
	return false
}

type Decision struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

// MaxDecisionOptionLength is the shared baseline for generic decision labels.
// Native bridges may impose tighter question/count/format limits separately.
const MaxDecisionOptionLength = 120

// ValidDecision validates exact supplied text without normalizing it. Generic
// decisions deliberately retain no question-length or option-count upper limit.
func ValidDecision(d *Decision) bool {
	if d == nil || strings.TrimSpace(d.Question) == "" || len(d.Options) < 2 {
		return false
	}
	seen := map[string]bool{}
	for _, option := range d.Options {
		if strings.TrimSpace(option) == "" || utf8.RuneCountInString(option) > MaxDecisionOptionLength || seen[option] {
			return false
		}
		seen[option] = true
	}
	return true
}

type Event struct {
	Origin    string `json:"origin,omitempty"`
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Message   string `json:"message"`
	RunID     string `json:"run_id"`
	CreatedAt string `json:"created_at"`
}
type Command struct {
	Question  string `json:"question,omitempty"`
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Message   string `json:"message"`
	RunID     string `json:"run_id"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// CodexBinding pins only the fresh local CLI run's first decision. The path is
// represented by a SHA-256 fingerprint, never an absolute directory.
type CodexBinding struct {
	Version        int      `json:"version"`
	NativeThreadID string   `json:"native_thread_id"`
	TaskID         string   `json:"task_id"`
	RunID          string   `json:"run_id"`
	Question       string   `json:"question"`
	Options        []string `json:"options"`
	CWDFingerprint string   `json:"cwd_fingerprint"`
	Sandbox        string   `json:"sandbox"`
}

var bindingUUID = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var bindingFingerprint = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func ValidCodexBinding(b *CodexBinding, task, run string, d *Decision) bool {
	return b != nil && b.Version == 1 && bindingUUID.MatchString(b.NativeThreadID) && b.TaskID == task && b.RunID == run && bindingFingerprint.MatchString(b.CWDFingerprint) && (b.Sandbox == "read-only" || b.Sandbox == "workspace-write") && d != nil && b.Question == d.Question && slices.Equal(b.Options, d.Options) && len(b.Options) >= 2 && len(b.Options) <= 8
}
func SameCodexBinding(a, b *CodexBinding) bool {
	return a != nil && b != nil && a.Version == b.Version && a.NativeThreadID == b.NativeThreadID && a.TaskID == b.TaskID && a.RunID == b.RunID && a.Question == b.Question && slices.Equal(a.Options, b.Options) && a.CWDFingerprint == b.CWDFingerprint && a.Sandbox == b.Sandbox
}

// CodexStartObservation is an immutable historical fact reported by the opt-in
// bridge after its first validated native turn.started. It is not liveness.
type CodexStartObservation struct {
	RunID          string `json:"run_id"`
	NativeThreadID string `json:"native_thread_id"`
	ObservedAt     string `json:"observed_at"`
}

// CodexLaunchNotice records only a fixed initial preflight category and server
// date. It does not claim execution, consume the run, or preserve diagnostics.
type CodexLaunchNotice struct {
	Category   string `json:"category"`
	RecordedAt string `json:"recorded_at"`
}

// DeliveryReview is the local human's "seen" marker for one exact report,
// never acceptance, independent verification, or lifecycle completion.
type DeliveryReview struct {
	RunID         string `json:"run_id"`
	ReportEventID string `json:"report_event_id"`
	ReviewedAt    string `json:"reviewed_at"`
}

// LocalFollowUp is a reversible local list marker, not execution completion.
// Keeping its open state supplies a stale-toggle token without adding history.
type LocalFollowUp struct {
	RunID         string `json:"run_id"`
	ReportEventID string `json:"report_event_id"`
	State         string `json:"state"`
	RecordedAt    string `json:"recorded_at"`
}

// PreviousDeliveryEvidence is one bounded previous ready snapshot, not a merged
// evidence source or report history system. Complete entries form a prefix.
type PreviousDeliveryEvidence struct {
	RunID            string     `json:"run_id"`
	ReportEventID    string     `json:"report_event_id"`
	ReportedAt       string     `json:"reported_at"`
	Origin           string     `json:"origin"`
	Summary          string     `json:"summary"`
	SummaryTruncated bool       `json:"summary_truncated,omitempty"`
	TotalCount       int        `json:"total_count"`
	Evidence         []Evidence `json:"evidence"`
}

// This optional fixed reason explains a size-driven omission when it also fits.
type PreviousEvidenceUnretained struct {
	RunID         string `json:"run_id"`
	ReportEventID string `json:"report_event_id"`
	Reason        string `json:"reason"`
}

type Task struct {
	LocalVisibility            *LocalVisibility            `json:"local_visibility,omitempty"`
	PreviousBlockedAttempts    []PreviousBlockedAttempt    `json:"previous_blocked_attempts,omitempty"`
	PreviousEvidenceUnretained *PreviousEvidenceUnretained `json:"previous_evidence_unretained,omitempty"`
	PreviousDeliveryEvidence   *PreviousDeliveryEvidence   `json:"previous_delivery_evidence,omitempty"`
	LocalFollowUp              *LocalFollowUp              `json:"local_follow_up,omitempty"`
	DeliveryReview             *DeliveryReview             `json:"delivery_review,omitempty"`
	CodexLaunchNotice          *CodexLaunchNotice          `json:"codex_launch_notice,omitempty"`
	CodexStart                 *CodexStartObservation      `json:"codex_start,omitempty"`
	CodexBinding               *CodexBinding               `json:"codex_binding,omitempty"`
	Source                     string                      `json:"source,omitempty"`
	Origin                     string                      `json:"origin,omitempty"`
	ID                         string                      `json:"id"`
	ProjectName                string                      `json:"project_name,omitempty"`
	ProjectID                  string                      `json:"project_id"`
	Title                      string                      `json:"title"`
	Goal                       string                      `json:"goal"`
	Status                     string                      `json:"status"`
	RunID                      string                      `json:"run_id"`
	Summary                    string                      `json:"summary"`
	UpdatedAt                  string                      `json:"updated_at"`
	ObservedAt                 string                      `json:"observed_at"`
	Evidence                   []Evidence                  `json:"evidence"`
	Decision                   *Decision                   `json:"decision"`
	FollowUpCount              int                         `json:"follow_up_count"`
	Events                     []Event                     `json:"events"`
	Commands                   []Command                   `json:"commands"`
}

// TaskBriefExpectation is a transient claim guard, never saved as task metadata.
type TaskBriefExpectation struct {
	Title string `json:"title"`
	Goal  string `json:"goal"`
}

// currentRunEvents retains task history while every execution gate uses only the
// current run. A fresh run must still have its one explicit local starting event.
func currentRunEvents(t Task) []Event {
	var events []Event
	for _, event := range t.Events {
		if event.RunID == t.RunID {
			events = append(events, event)
		}
	}
	return events
}

func untouchedLocalRun(t Task) bool {
	events := currentRunEvents(t)
	return t.Source == "local" && t.ProjectID == "local" && t.RunID != "" && t.Status == "not_started" && len(events) == 1 && (events[0].Kind == "local_retry_created" || (events[0].Kind == "local_created" && len(t.Events) == 1)) && len(t.Commands) == 0 && len(t.Evidence) == 0 && t.Decision == nil && t.CodexBinding == nil && t.CodexStart == nil && t.DeliveryReview == nil && t.LocalFollowUp == nil && t.FollowUpCount == 0 && t.PreviousDeliveryEvidence == nil && t.PreviousEvidenceUnretained == nil
}

func ValidFreshTaskBrief(t Task) bool {
	return untouchedLocalRun(t) && strings.TrimSpace(t.Title) != "" && t.Title == strings.TrimSpace(t.Title) && utf8.ValidString(t.Title) && utf8.RuneCountInString(t.Title) <= 160 && strings.TrimSpace(t.Goal) != "" && t.Goal == strings.TrimSpace(t.Goal) && utf8.ValidString(t.Goal) && utf8.RuneCountInString(t.Goal) <= 2000
}

type Input struct {
	ExpectedTaskBrief *TaskBriefExpectation `json:"expected_task_brief,omitempty"`
	CodexBinding      *CodexBinding         `json:"codex_binding,omitempty"`
	Origin            string                `json:"origin,omitempty"`
	RunID             string                `json:"run_id"`
	Answer            string                `json:"answer"`
	Kind              string                `json:"kind"`
	Message           string                `json:"message"`
	Evidence          []Evidence            `json:"evidence"`
	CommandID         string                `json:"command_id"`
	Decision          *Decision             `json:"decision"`
}
type Store struct{ db *sql.DB }

var ErrConflict = errors.New("state conflict")

func now() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func Open(path string) (*Store, error) {
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	s := &Store{db}
	_, e = db.Exec(`CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, data TEXT NOT NULL)`)
	if e != nil {
		db.Close()
		return nil, e
	}
	if e = s.initFollowUps(); e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}
func (s *Store) Close() error { return s.db.Close() }
func (s *Store) Seed() error {
	items, err := s.List()
	if err != nil {
		return err
	}
	for _, t := range items {
		if t.ProjectID != "demo" {
			return errors.New("demo seed requires an empty or demo-only database; use a separate -db")
		}
	}
	for _, t := range seed() {
		b, _ := marshalTask(&t)
		if _, e := s.db.Exec(`INSERT OR IGNORE INTO tasks VALUES(?,?)`, t.ID, string(b)); e != nil {
			return e
		}
	}
	return nil
}

// Create records locally owned work only. It starts no Agent or execution.
type CreateInput struct {
	ProjectName string `json:"project_name,omitempty"`
	Title       string `json:"title"`
	Goal        string `json:"goal"`
	Origin      string `json:"origin"`
}

func (s *Store) Create(in CreateInput) (Task, error) {
	items, err := s.List()
	if err != nil {
		return Task{}, err
	}
	for _, t := range items {
		if t.ProjectID == "demo" {
			return Task{}, errors.New("real local work requires a separate blank database without -demo")
		}
	}
	in.Title, in.Goal, in.Origin = strings.TrimSpace(in.Title), strings.TrimSpace(in.Goal), strings.TrimSpace(in.Origin)
	in.ProjectName, err = normalizeProjectName(in.ProjectName)
	if err != nil {
		return Task{}, err
	}
	if in.Title == "" || in.Goal == "" || in.Origin == "" {
		return Task{}, errors.New("title, goal and origin are required")
	}
	if utf8.RuneCountInString(in.Title) > 160 || utf8.RuneCountInString(in.Goal) > 2000 || utf8.RuneCountInString(in.Origin) > 300 {
		return Task{}, errors.New("title, goal or origin exceeds its limit (160 / 2000 / 300 characters)")
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return Task{}, err
	}
	taskID := fmt.Sprintf("work-%x", id)
	stamp := now()
	t := Task{ID: taskID, ProjectID: "local", ProjectName: in.ProjectName, Title: in.Title, Goal: in.Goal, Source: "local", Origin: in.Origin, Status: "not_started", RunID: taskID + "-run-1", Summary: "已记录目标，尚未收到执行回报；不会自动启动 Agent。", UpdatedAt: stamp, Evidence: []Evidence{}, Commands: []Command{}, Events: []Event{{ID: taskID + "-e1", Kind: "local_created", Message: "本地创建工作记录，未启动执行。", RunID: taskID + "-run-1", CreatedAt: stamp, Origin: in.Origin}}}
	b, err := marshalTask(&t)
	if err != nil {
		return Task{}, err
	}
	_, err = s.db.Exec(`INSERT INTO tasks VALUES(?,?)`, t.ID, string(b))
	return t, err
}

const maxProjectNameLength = 60

func normalizeProjectName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxProjectNameLength {
		return "", errors.New("project_name must be valid text of at most 60 characters")
	}
	return name, nil
}

// SetProjectName changes explicit human display metadata, never the internal
// project namespace or execution identity. The handler requires an explicit string.
func (s *Store) SetProjectName(id, name string) (Task, error) {
	name, err := normalizeProjectName(name)
	if err != nil {
		return Task{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	var data string
	var t Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		return t, err
	}
	if err = json.Unmarshal([]byte(data), &t); err != nil {
		return t, err
	}
	if t.Source != "local" || t.ProjectID != "local" {
		return t, fmt.Errorf("%w: project_name can only label local work", ErrConflict)
	}
	if t.ProjectName == name {
		return t, nil
	}
	t.ProjectName = name
	// Metadata must not discard optional evidence to make room for its label.
	encoded, err := json.Marshal(t)
	if err != nil {
		return t, err
	}
	if len(encoded)+1 > maxTaskReadbackBytes {
		return t, errors.New("project_name change exceeds the existing task readback limit")
	}
	if _, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), id); err != nil {
		return t, err
	}
	return t, tx.Commit()
}

func (s *Store) List() ([]Task, error) {
	rows, e := s.db.Query(`SELECT data FROM tasks ORDER BY id`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []Task{}
	for rows.Next() {
		var b string
		var t Task
		if e = rows.Scan(&b); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(b), &t); e != nil {
			return nil, e
		}
		out = append(out, t)
	}
	return out, rows.Err()
}
func (s *Store) Get(id string) (Task, error) {
	var b string
	var t Task
	e := s.db.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&b)
	if e == nil {
		e = json.Unmarshal([]byte(b), &t)
	}
	return t, e
}

// CurrentReadyReportID pins the current evidence-bearing delivery queued for review.
// Receipt bookkeeping does not replace report content; a later formal report does.
func CurrentReadyReportID(t Task) string {
	if t.Source != "local" || t.ProjectID == "demo" || t.Status != "ready" || !usableEvidence(t.Evidence) {
		return ""
	}
	for i := len(t.Events) - 1; i >= 0; i-- {
		event := t.Events[i]
		if event.RunID != t.RunID || !strings.HasPrefix(event.Kind, "reports:") || event.Kind == "reports:receipt" {
			continue
		}
		if event.Kind == "reports:ready" || event.Kind == "reports:completed" {
			return event.ID
		}
		return ""
	}
	return ""
}

const maxPreviousEvidenceCount = 8
const maxPreviousEvidenceBytes = 32 << 10
const maxTaskReadbackBytes = 1 << 20

func previousReadyEvidence(t Task) *PreviousDeliveryEvidence {
	reportID := CurrentReadyReportID(t)
	if reportID == "" {
		return nil
	}
	var report Event
	for _, event := range t.Events {
		if event.ID == reportID && event.RunID == t.RunID {
			report = event
			break
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, report.CreatedAt); err != nil {
		return nil
	}
	summary := []rune(t.Summary)
	truncated := len(summary) > 500
	if truncated {
		summary = summary[:500]
	}
	snapshot := &PreviousDeliveryEvidence{RunID: t.RunID, ReportEventID: reportID, ReportedAt: report.CreatedAt, Origin: report.Origin, Summary: string(summary), SummaryTruncated: truncated, TotalCount: len(t.Evidence), Evidence: []Evidence{}}
	for _, entry := range t.Evidence {
		if len(snapshot.Evidence) >= maxPreviousEvidenceCount {
			break
		}
		snapshot.Evidence = append(snapshot.Evidence, entry)
		encoded, err := json.Marshal(snapshot)
		if err != nil || len(encoded) > maxPreviousEvidenceBytes {
			snapshot.Evidence = snapshot.Evidence[:len(snapshot.Evidence)-1]
			break
		}
	}
	return snapshot
}

// Optional history must not be what makes an individual task exceed the CLI's
// existing 1 MiB readback bound (including JSON encoder's trailing newline).
// Dropping it never blocks or alters the new authoritative report.
func marshalTask(t *Task) ([]byte, error) {
	encoded, err := json.Marshal(t)
	if err != nil || len(encoded)+1 <= maxTaskReadbackBytes {
		return encoded, err
	}
	if previous := t.PreviousDeliveryEvidence; previous != nil {
		t.PreviousDeliveryEvidence = nil
		t.PreviousEvidenceUnretained = &PreviousEvidenceUnretained{RunID: previous.RunID, ReportEventID: previous.ReportEventID, Reason: "task_size_limit"}
	}
	if t.PreviousEvidenceUnretained != nil {
		encoded, err = json.Marshal(t)
		if err == nil && len(encoded)+1 > maxTaskReadbackBytes {
			t.PreviousEvidenceUnretained = nil
			encoded, err = json.Marshal(t)
		}
	}
	if err == nil && len(encoded)+1 > maxTaskReadbackBytes {
		return nil, errors.New("task exceeds the 1 MiB readback limit; change not saved; shorten the report or use a concise evidence reference")
	}
	return encoded, err
}

// ReviewDelivery saves a view-only local observation, not an execution event.
// The exact report ID is checked in the same transaction as the marker write.
func (s *Store) ReviewDelivery(id, run, reportID string) (Task, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	var data string
	var t Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		return t, err
	}
	if err = json.Unmarshal([]byte(data), &t); err != nil {
		return t, err
	}
	if run == "" || run != t.RunID || reportID == "" || reportID != CurrentReadyReportID(t) {
		return t, fmt.Errorf("%w: current ready delivery changed or is not reviewable; refresh before marking seen", ErrConflict)
	}
	if t.DeliveryReview != nil && t.DeliveryReview.RunID == run && t.DeliveryReview.ReportEventID == reportID {
		return t, nil
	}
	t.DeliveryReview = &DeliveryReview{RunID: run, ReportEventID: reportID, ReviewedAt: now()}
	encoded, err := marshalTask(&t)
	if err != nil {
		return t, err
	}
	if _, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), id); err != nil {
		return t, err
	}
	return t, tx.Commit()
}

// SetLocalFollowUp changes only local list membership for a viewed report.
// Opposing stale toggles reject; repeated desired states are unchanged no-ops.
func (s *Store) SetLocalFollowUp(id, run, reportID, operation, expectedAt string) (Task, error) {
	if operation != "end" && operation != "resume" {
		return Task{}, errors.New("local follow-up requires end or resume")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	var data string
	var t Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		return t, err
	}
	if err = json.Unmarshal([]byte(data), &t); err != nil {
		return t, err
	}
	if run == "" || run != t.RunID || reportID == "" || reportID != CurrentReadyReportID(t) || t.DeliveryReview == nil || t.DeliveryReview.RunID != run || t.DeliveryReview.ReportEventID != reportID || t.DeliveryReview.ReviewedAt == "" {
		return t, fmt.Errorf("%w: local follow-up requires the exact current viewed ready report", ErrConflict)
	}
	state, revision := "open", ""
	if marker := t.LocalFollowUp; marker != nil && marker.RunID == run && marker.ReportEventID == reportID && (marker.State == "ended" || marker.State == "open") && marker.RecordedAt != "" {
		state, revision = marker.State, marker.RecordedAt
	}
	desired := "ended"
	if operation == "resume" {
		desired = "open"
	}
	if state == desired {
		return t, nil
	}
	if revision != expectedAt {
		return t, fmt.Errorf("%w: local follow-up marker changed; refresh before acting", ErrConflict)
	}
	t.LocalFollowUp = &LocalFollowUp{RunID: run, ReportEventID: reportID, State: desired, RecordedAt: now()}
	encoded, err := marshalTask(&t)
	if err != nil {
		return t, err
	}
	if _, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), id); err != nil {
		return t, err
	}
	return t, tx.Commit()
}

// CodexBridgeFailureOrigin identifies the bridge's own failure report, not a
// successful model turn's blocked diagnosis or an arbitrary manual report.
const CodexBridgeFailureOrigin = "Codex CLI bridge; no successful delivery claimed"

// NewAttemptInput pins the failed attempt and requires a human's explicit
// stopped-process attestation. A blocked report is never treated as liveness.
type NewAttemptInput struct {
	RunID          string `json:"run_id"`
	FailedEventID  string `json:"failed_event_id"`
	ConfirmStopped bool   `json:"confirm_stopped"`
}

// RetryableFailedEventID recognizes the original safe pre-start failure or the
// narrow first native blocked result with an exact saved start observation.
// Neither eligibility path establishes liveness or replaces explicit stop consent.
func RetryableFailedEventID(t Task) string {
	if eventID := retryableNativeBlockedEventID(t); eventID != "" {
		return eventID
	}
	if t.Source != "local" || t.ProjectID != "local" || t.Status != "blocked" || t.RunID == "" || t.CodexLaunchNotice != nil || t.CodexStart != nil || t.CodexBinding != nil || t.Decision != nil || len(t.Evidence) != 0 || len(t.Commands) != 0 || t.FollowUpCount != 0 || t.PreviousDeliveryEvidence != nil || t.PreviousEvidenceUnretained != nil || t.DeliveryReview != nil || t.LocalFollowUp != nil {
		return ""
	}
	for _, event := range t.Events {
		switch event.Kind {
		case "local_created", "local_retry_created", "codex-start:", "reports:failed":
		default:
			return ""
		}
	}
	events := currentRunEvents(t)
	if len(events) != 3 || (events[0].Kind != "local_created" && events[0].Kind != "local_retry_created") || events[1].Kind != "codex-start:" || events[2].Kind != "reports:failed" || events[2].Origin != CodexBridgeFailureOrigin || events[2].ID == "" || len(t.Events) == 0 || t.Events[len(t.Events)-1] != events[2] {
		return ""
	}
	return events[2].ID
}

// NewAttempt adds a manual unclaimed run to the same task, never launches or
// resumes a native thread, and preserves every historical event and identifier.
func (s *Store) NewAttempt(id string, in NewAttemptInput) (Task, error) {
	if !in.ConfirmStopped || strings.TrimSpace(in.RunID) == "" || strings.TrimSpace(in.FailedEventID) == "" {
		return Task{}, errors.New("run_id, failed_event_id and confirm_stopped:true are required; verify the old local and external processes have stopped")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Task{}, err
	}
	defer tx.Rollback()
	var data string
	var t Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		return t, err
	}
	if err = json.Unmarshal([]byte(data), &t); err != nil {
		return t, err
	}
	if t.ID != id || in.RunID != t.RunID || in.FailedEventID != RetryableFailedEventID(t) {
		return t, fmt.Errorf("%w: requires the unchanged eligible local failure and an explicit stopped-process confirmation; refresh before creating an attempt", ErrConflict)
	}
	var random [16]byte
	if _, err = rand.Read(random[:]); err != nil {
		return t, err
	}
	run := fmt.Sprintf("%s-run-%x", t.ID, random)
	for _, event := range t.Events {
		if event.RunID == run {
			return t, errors.New("new attempt identifier collision; change not saved")
		}
	}
	stamp := now()
	eventID := fmt.Sprintf("%s-e%d", t.ID, len(t.Events)+1)
	for _, event := range t.Events {
		if event.ID == eventID {
			return t, errors.New("new attempt event identifier collision; change not saved")
		}
	}
	if retryableNativeBlockedEventID(t) != "" {
		// Preserve the entire diagnostic evidence before clearing current state.
		// This archive is mandatory, never a size-trimmed optional snapshot.
		t.PreviousBlockedAttempts = append(t.PreviousBlockedAttempts, PreviousBlockedAttempt{RunID: t.RunID, ReportEventID: in.FailedEventID, CodexStart: *t.CodexStart, Evidence: t.Evidence})
		t.CodexStart = nil
		t.Evidence = []Evidence{}
	}
	t.LocalVisibility = nil
	t.RunID, t.Status, t.UpdatedAt, t.ObservedAt = run, "not_started", stamp, ""
	t.Summary = "已手动建立新尝试，尚未领取或启动；原失败记录保留。"
	t.Events = append(t.Events, Event{ID: eventID, Kind: "local_retry_created", Message: "用户明确确认原本地及外部执行已停止，手动建立新尝试；未启动执行。", RunID: run, CreatedAt: stamp, Origin: "local human retry; stopped explicitly confirmed"})
	encoded, err := marshalTask(&t)
	if err != nil {
		return t, err
	}
	if _, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), id); err != nil {
		return t, err
	}
	return t, tx.Commit()
}

// NoteCodexMissing only annotates untouched local work. Repeated, delayed or
// resumed checks cannot dirty newer state, and manual reports are not fresh.
func (s *Store) NoteCodexMissing(id, run string) (CodexLaunchNotice, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return CodexLaunchNotice{}, err
	}
	defer tx.Rollback()
	var data string
	var t Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		return CodexLaunchNotice{}, err
	}
	if err = json.Unmarshal([]byte(data), &t); err != nil {
		return CodexLaunchNotice{}, err
	}
	if run == "" || run != t.RunID || !untouchedLocalRun(t) || t.CodexLaunchNotice != nil {
		return CodexLaunchNotice{}, fmt.Errorf("%w: launch notice requires untouched local work", ErrConflict)
	}
	notice := CodexLaunchNotice{Category: "missing_executable", RecordedAt: now()}
	t.CodexLaunchNotice = &notice
	// A new current-run startup diagnostic is new information, not hidden history.
	t.LocalVisibility = nil
	encoded, err := marshalTask(&t)
	if err != nil {
		return CodexLaunchNotice{}, err
	}
	if _, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), id); err != nil {
		return CodexLaunchNotice{}, err
	}
	return notice, tx.Commit()
}

// ObserveCodexStart deliberately bypasses Apply's lifecycle timestamps/events.
// Only the untouched initial claim accepts this best-effort display fact; a
// delayed observer must never change a decision, delivery, failure or newer run.
func (s *Store) ObserveCodexStart(id, run, nativeID string) (CodexStartObservation, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return CodexStartObservation{}, err
	}
	defer tx.Rollback()
	var data string
	var t Task
	if err = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		return CodexStartObservation{}, err
	}
	if err = json.Unmarshal([]byte(data), &t); err != nil {
		return CodexStartObservation{}, err
	}
	if run == "" || run != t.RunID || t.Source != "local" || t.Status != "working" || t.CodexStart != nil || len(t.Events) == 0 || t.Events[len(t.Events)-1].Kind != "codex-start:" || t.Events[len(t.Events)-1].RunID != run {
		return CodexStartObservation{}, fmt.Errorf("%w: native start observation requires the untouched initial claim", ErrConflict)
	}
	if !bindingUUID.MatchString(nativeID) {
		return CodexStartObservation{}, errors.New("native start observation requires a valid UUID")
	}
	observation := CodexStartObservation{RunID: run, NativeThreadID: nativeID, ObservedAt: now()}
	t.CodexStart = &observation
	encoded, err := marshalTask(&t)
	if err != nil {
		return CodexStartObservation{}, err
	}
	if _, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), id); err != nil {
		return CodexStartObservation{}, err
	}
	return observation, tx.Commit()
}

func (s *Store) Apply(id, action string, in Input) (Task, error) {
	tx, e := s.db.Begin()
	if e != nil {
		return Task{}, e
	}
	defer tx.Rollback()
	var b string
	var t Task
	if e = tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&b); e != nil {
		return t, e
	}
	if e = json.Unmarshal([]byte(b), &t); e != nil {
		return t, e
	}
	if in.RunID == "" || in.RunID != t.RunID {
		return t, fmt.Errorf("%w: execution changed; refresh before acting", ErrConflict)
	}
	if in.ExpectedTaskBrief != nil && action != "codex-start" {
		return t, errors.New("task brief expectation is only valid for a fresh Codex claim")
	}
	if in.CodexBinding != nil && (action != "reports" || (in.Kind != "needs_decision" && in.Kind != "receipt")) {
		return t, errors.New("codex binding is only valid for its decision or receipt")
	}
	stamp := now()
	addCommand := func(kind, msg string) {
		t.Commands = append(t.Commands, Command{ID: fmt.Sprintf("%s-c%d", t.ID, len(t.Commands)+1), Kind: kind, Message: msg, RunID: t.RunID, Status: "recorded", CreatedAt: stamp})
	}
	switch action {
	case "codex-start":
		// A one-shot local claim, not a queue or permission to restart an old
		// execution. The transaction prevents two CLI processes starting it.
		if !untouchedLocalRun(t) {
			return t, fmt.Errorf("%w: codex-run requires an untouched explicit local attempt; inspect the existing run", ErrConflict)
		}
		if expected := in.ExpectedTaskBrief; expected != nil && (!ValidFreshTaskBrief(t) || expected.Title != t.Title || expected.Goal != t.Goal) {
			return t, fmt.Errorf("%w: saved task brief changed or is not fresh; no claim consumed", ErrConflict)
		}
		for _, event := range t.Events {
			if event.RunID == t.RunID && event.Kind == "codex-start:" {
				return t, fmt.Errorf("%w: codex-run already claimed this run", ErrConflict)
			}
		}
		if strings.TrimSpace(in.Origin) == "" || utf8.RuneCountInString(in.Origin) > 300 {
			return t, errors.New("codex-run requires an origin of at most 300 characters")
		}
		t.CodexLaunchNotice = nil // this real claim supersedes the old preflight notice
		t.Status = "working"
		t.Summary = "已领取一次显式 Codex 执行；尚未证明启动或交付。"
	case "decisions":
		if t.Decision == nil {
			return t, fmt.Errorf("%w: no open decision", ErrConflict)
		}
		if (t.CodexBinding != nil && in.Decision == nil) || (in.Decision != nil && (in.Decision.Question != t.Decision.Question || !slices.Equal(in.Decision.Options, t.Decision.Options))) {
			return t, fmt.Errorf("%w: observed question/options changed; refresh before choosing", ErrConflict)
		}
		valid := false
		for _, o := range t.Decision.Options {
			if o == in.Answer {
				valid = true
			}
		}
		if !valid {
			return t, errors.New("answer must match an offered option")
		}
		for _, c := range t.Commands {
			if c.Kind == "decision" && c.Question == t.Decision.Question {
				return t, fmt.Errorf("%w: decision already recorded", ErrConflict)
			}
		}
		addCommand("decision", in.Answer)
		t.Commands[len(t.Commands)-1].Question = t.Decision.Question
	case "follow-up":
		if t.Status != "needs_evidence" || t.FollowUpCount != 0 {
			return t, fmt.Errorf("%w: follow-up unavailable or already recorded", ErrConflict)
		}
		t.FollowUpCount++
		addCommand("follow_up", "请在同一执行中补充交付证据；不要启动新执行。")
	case "reports":
		if t.Source == "local" && (strings.TrimSpace(in.Origin) == "" || utf8.RuneCountInString(in.Origin) > 300) {
			return t, errors.New("local work reports require an origin of at most 300 characters")
		}
		if in.Kind == "receipt" {
			if t.CodexBinding != nil || in.CodexBinding != nil {
				if t.Source != "local" || t.Status != "needs_decision" || !ValidCodexBinding(t.CodexBinding, t.ID, t.RunID, t.Decision) || !SameCodexBinding(t.CodexBinding, in.CodexBinding) {
					return t, fmt.Errorf("%w: pinned Codex decision changed or invalid", ErrConflict)
				}
				matches := 0
				for _, c := range t.Commands {
					if c.Kind == "decision" && c.RunID == t.RunID && c.Question == t.Decision.Question {
						matches++
						if c.ID != in.CommandID || c.Status != "recorded" || !slices.Contains(t.Decision.Options, c.Message) {
							return t, fmt.Errorf("%w: pinned Codex answer changed or consumed", ErrConflict)
						}
					}
				}
				if matches != 1 {
					return t, fmt.Errorf("%w: expected one exact Codex answer", ErrConflict)
				}
			}
			found := false
			for i := range t.Commands {
				if t.Commands[i].ID == in.CommandID && t.Commands[i].RunID == in.RunID {
					if t.Commands[i].Status != "recorded" {
						return t, fmt.Errorf("%w: already acknowledged", ErrConflict)
					}
					t.Commands[i].Status = "acknowledged"
					found = true
				}
			}
			if !found {
				return t, errors.New("receipt must name an existing command in this run")
			}
		} else {
			if in.CodexBinding != nil {
				// Only the first report directly following this fresh claim
				// may install a binding. Manual reports cannot rebind a run.
				if t.Source != "local" || t.Status != "working" || len(t.Events) == 0 || t.Events[len(t.Events)-1].Kind != "codex-start:" || t.Events[len(t.Events)-1].RunID != t.RunID || !ValidCodexBinding(in.CodexBinding, t.ID, t.RunID, in.Decision) {
					return t, fmt.Errorf("%w: binding requires the fresh local Codex claim and exact decision", ErrConflict)
				}
			}
			// Any unrelated report invalidates continuation. Receipt alone
			// retains the binding; an acknowledged answer is never resumable.
			t.CodexBinding = in.CodexBinding
			if strings.TrimSpace(in.Message) == "" {
				return t, errors.New("message is required")
			}
			for _, item := range in.Evidence {
				if utf8.RuneCountInString(item.Excerpt) > maxEvidenceExcerpt {
					return t, errors.New("evidence excerpt must be at most 2000 characters")
				}
			}
			switch in.Kind {
			case "progress":
				t.Status = "working"
				t.Decision = nil
			case "needs_decision":
				if !ValidDecision(in.Decision) {
					return t, errors.New("decision requires a nonblank question and at least two exact-distinct nonblank options of at most 120 characters each")
				}
				for _, c := range t.Commands {
					if c.Kind != "decision" || c.RunID != t.RunID || c.Question != in.Decision.Question {
						continue
					}
					return t, fmt.Errorf("%w: question already answered in this run; use distinct question wording", ErrConflict)
				}
				t.Decision = in.Decision
				t.Status = "needs_decision"
			case "ready":
				t.Decision = nil
				if !usableEvidence(in.Evidence) {
					t.Status = "needs_evidence"
				} else {
					// Capture before evidence/summary/events are replaced. No
					// valid current same-run ready report means no history.
					t.PreviousDeliveryEvidence = previousReadyEvidence(t)
					t.PreviousEvidenceUnretained = nil
					t.Status = "ready"
				}
			case "completed":
				if !usableEvidence(in.Evidence) {
					return t, errors.New("completion requires a labeled HTTP(S) link or inline evidence excerpt")
				}
				// Completed is a reporter's claim, not human acceptance. Keep
				// its exact event kind while queuing the new evidence for review.
				t.PreviousDeliveryEvidence = previousReadyEvidence(t)
				t.PreviousEvidenceUnretained = nil
				t.Status = "ready"
				t.Decision = nil
			case "failed":
				t.Decision = nil
				t.Status = "blocked"
			default:
				return t, errors.New("unsupported report kind")
			}
			// New substantive same-run information must return hidden work to view.
			// Receipt-only bookkeeping above deliberately preserves the marker.
			t.LocalVisibility = nil
			t.Summary = in.Message
			if in.Evidence != nil {
				t.Evidence = in.Evidence
				// Explicit clearing is not an invitation to retain an optional copy.
				if len(in.Evidence) == 0 {
					t.PreviousDeliveryEvidence = nil
					t.PreviousEvidenceUnretained = nil
				}
			}
		}
		t.ObservedAt = stamp
	default:
		return t, errors.New("unsupported action")
	}
	t.UpdatedAt = stamp
	t.Events = append(t.Events, Event{ID: fmt.Sprintf("%s-e%d", t.ID, len(t.Events)+1), Origin: in.Origin, Kind: action + ":" + in.Kind, Message: in.Message + in.Answer, RunID: t.RunID, CreatedAt: stamp})
	data, e := marshalTask(&t)
	if e != nil {
		return t, e
	}
	if _, e = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), id); e != nil {
		return t, e
	}
	return t, tx.Commit()
}
func Projects() []Project {
	return []Project{{"local", "我的本地工作", "由你创建目标，手工或 CLI 回报；不自动运行 Agent。"}, {"demo", "工作台试用 · 合成项目", "少催促、不错认完成，把注意力留给真正的决定。"}}
}
func seed() []Task {
	stamp := now()
	out := []Task{
		{ID: "t1", Title: "修复空搜索结果的展示", Goal: "空结果应说明下一步，不扩大后端范围。", Status: "working", Summary: "正在补充空状态测试。"},
		{ID: "t2", Title: "数据库查询优化：确认范围", Goal: "只解决实际慢查询，不做微小计算优化。", Status: "needs_decision", Summary: "发现两个实现方向，需要确认取舍。", Decision: &Decision{"先解决哪个问题？", []string{"只修复重复查询", "先提供查询证据，不改代码"}}},
		{ID: "t3", Title: "补齐列表回归证据", Goal: "同一执行交付测试结果，而不是重新派活。", Status: "needs_evidence", Summary: "Agent 报告已做完，但未提供测试证据。"},
		{ID: "t4", Title: "整理重复文档修改", Goal: "合并为一份小而可审阅的交付。", Status: "ready", Summary: "已提供合成验收记录，等待用户检查。", Evidence: []Evidence{{Label: "合成测试记录（非真实交付）", URL: "#synthetic-evidence", Origin: "合成演示"}}},
	}
	for i := range out {
		t := &out[i]
		t.ProjectID = "demo"
		t.Source = "synthetic"
		t.Origin = "合成演示（未连接 Agent）"
		t.RunID = t.ID + "-run-1"
		t.UpdatedAt = stamp
		t.ObservedAt = stamp
		t.Commands = []Command{}
		t.Events = []Event{{ID: t.ID + "-e1", Kind: "synthetic_seed", Message: "合成数据：未连接任何真实 Agent。", RunID: t.RunID, CreatedAt: stamp, Origin: "合成演示"}}
		if t.Evidence == nil {
			t.Evidence = []Evidence{}
		}
	}
	return out
}
