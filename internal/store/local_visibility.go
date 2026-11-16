package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// LocalVisibility affects only this workbench's local list. It never changes
// execution, completion, evidence, history, ownership or report-review state.
// A visible marker is retained to reject an opposing delayed toggle.
type LocalVisibility struct {
	// Preserve unknown legacy revision tokens without treating them as current hide authority.
	Revision               string `json:"revision,omitempty"`
	LaunchNoticeRecordedAt string `json:"launch_notice_recorded_at"`
	RunID                  string `json:"run_id"`
	State                  string `json:"state"`
	RecordedAt             string `json:"recorded_at"`
	LastReportEventID      string `json:"last_report_event_id"`
}

type LocalVisibilityInput struct {
	LaunchNoticeRecordedAt string `json:"launch_notice_recorded_at"`
	RunID                  string `json:"run_id"`
	Operation              string `json:"operation"`
	ExpectedRecordedAt     string `json:"expected_recorded_at"`
	LastReportEventID      string `json:"last_report_event_id"`
}

// LastSubstantiveReportID excludes receipts and events from older attempts.
// An empty ID explicitly means that this run has no substantive report yet.
func LastSubstantiveReportID(t Task) string {
	for i := len(t.Events) - 1; i >= 0; i-- {
		event := t.Events[i]
		if event.RunID == t.RunID && strings.HasPrefix(event.Kind, "reports:") && event.Kind != "reports:receipt" {
			return event.ID
		}
	}
	return ""
}

func launchNoticeRecordedAt(t Task) string {
	if t.CodexLaunchNotice != nil {
		return t.CodexLaunchNotice.RecordedAt
	}
	return ""
}

// SetLocalVisibility atomically checks the run, exact latest report, launch notice and marker
// revision observed by the caller. It adds no lifecycle event or command.
func (s *Store) SetLocalVisibility(id string, in LocalVisibilityInput) (Task, error) {
	if in.Operation != "hide" && in.Operation != "restore" {
		return Task{}, errors.New("local visibility requires hide or restore")
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
	if t.ID != id || t.Source != "local" || t.ProjectID != "local" || t.Decision != nil || in.LaunchNoticeRecordedAt != launchNoticeRecordedAt(t) || (t.Status != "not_started" && t.Status != "blocked") || in.RunID == "" || in.RunID != t.RunID || in.LastReportEventID != LastSubstantiveReportID(t) {
		return t, fmt.Errorf("%w: local visibility requires unchanged local not-started or blocked work", ErrConflict)
	}
	state, revision := "visible", ""
	if marker := t.LocalVisibility; marker != nil && marker.Revision == "" && marker.RunID == t.RunID && marker.LastReportEventID == in.LastReportEventID && marker.LaunchNoticeRecordedAt == in.LaunchNoticeRecordedAt && (marker.State == "hidden" || marker.State == "visible") && marker.RecordedAt != "" {
		state, revision = marker.State, marker.RecordedAt
	}
	if in.ExpectedRecordedAt != revision {
		return t, fmt.Errorf("%w: local visibility changed; refresh before acting", ErrConflict)
	}
	desired := "hidden"
	if in.Operation == "restore" {
		desired = "visible"
	}
	if state == desired {
		return t, nil
	}
	t.LocalVisibility = &LocalVisibility{RunID: t.RunID, State: desired, RecordedAt: now(), LastReportEventID: in.LastReportEventID, LaunchNoticeRecordedAt: in.LaunchNoticeRecordedAt}
	// Unlike marshalTask, a list-only mutation must never trim optional evidence.
	encoded, err := json.Marshal(t)
	if err != nil {
		return t, err
	}
	if len(encoded)+1 > maxTaskReadbackBytes {
		return t, errors.New("local visibility exceeds task readback limit; change not saved")
	}
	if _, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(encoded), id); err != nil {
		return t, err
	}
	return t, tx.Commit()
}
