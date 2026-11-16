package store

import (
	"strings"
	"time"
	"unicode/utf8"
)

// PreviousBlockedAttempt is the complete immutable diagnostic snapshot for one
// explicitly retired first native turn. The exact report text, origin and date
// remain in Events under ReportEventID; evidence is never merged into a new run.
// Unlike previous ready evidence, this archive must never be truncated or dropped.
type PreviousBlockedAttempt struct {
	RunID         string                `json:"run_id"`
	ReportEventID string                `json:"report_event_id"`
	CodexStart    CodexStartObservation `json:"codex_start"`
	Evidence      []Evidence            `json:"evidence"`
}

// retryableNativeBlockedEventID recognizes only the bridge's first successfully
// completed native turn declaring a blocked objective. The saved start fact is
// CLI-reported history, not independent verification or proof the process stopped.
// Any decision cycle, manual progress/report, or reviewed delivery is excluded.
func retryableNativeBlockedEventID(t Task) string {
	if t.Source != "local" || t.ProjectID != "local" || t.Status != "blocked" || t.RunID == "" || t.CodexLaunchNotice != nil || t.CodexStart == nil || t.CodexBinding != nil || t.Decision != nil || len(t.Commands) != 0 || t.FollowUpCount != 0 || t.PreviousDeliveryEvidence != nil || t.PreviousEvidenceUnretained != nil || t.DeliveryReview != nil || t.LocalFollowUp != nil {
		return ""
	}
	for _, previous := range t.PreviousBlockedAttempts {
		if previous.RunID == t.RunID {
			return ""
		}
	}
	for _, event := range t.Events {
		switch event.Kind {
		case "local_created", "local_retry_created", "codex-start:", "reports:failed":
		default:
			return ""
		}
	}
	events := currentRunEvents(t)
	if len(events) != 3 || (events[0].Kind != "local_created" && events[0].Kind != "local_retry_created") || events[1].Kind != "codex-start:" || events[2].Kind != "reports:failed" || events[2].ID == "" || len(t.Events) == 0 || t.Events[len(t.Events)-1] != events[2] {
		return ""
	}
	start, report := t.CodexStart, events[2]
	if start.RunID != t.RunID || !bindingUUID.MatchString(start.NativeThreadID) || report.Origin != "Codex CLI native thread "+start.NativeThreadID+"; model-declared blocked diagnosis and evidence, not independent verification" || report.Message != t.Summary || report.CreatedAt != t.ObservedAt {
		return ""
	}
	startedAt, startErr := time.Parse(time.RFC3339Nano, start.ObservedAt)
	reportedAt, reportErr := time.Parse(time.RFC3339Nano, report.CreatedAt)
	if startErr != nil || reportErr != nil || startedAt.After(reportedAt) {
		return ""
	}
	bounded := func(s string, max int) bool {
		return strings.TrimSpace(s) != "" && utf8.ValidString(s) && utf8.RuneCountInString(s) <= max
	}
	if !bounded(t.Summary, 2000) || len(t.Evidence) > 8 {
		return ""
	}
	for _, item := range t.Evidence {
		if !bounded(item.Label, 160) || !bounded(item.Excerpt, maxEvidenceExcerpt) || item.URL != "" || item.Origin != report.Origin {
			return ""
		}
	}
	return report.ID
}
