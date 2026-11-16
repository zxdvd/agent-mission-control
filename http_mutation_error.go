package main

import (
	"agentworkbench/internal/store"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// Only exact application-authored messages may cross the HTTP boundary. SQL,
// JSON corruption, OS paths and unexpected diagnostics never reach clients.
// Keep known validation/conflict text stable for CLI response reconciliation.
func safeMutationError(err error) (int, string) {
	if errors.Is(err, sql.ErrNoRows) {
		return http.StatusNotFound, "task not found"
	}
	if errors.Is(err, store.ErrConflict) {
		switch err.Error() {
		case "state conflict: already acknowledged":
			return http.StatusConflict, "state conflict: already acknowledged"
		case "state conflict: binding requires the fresh local Codex claim and exact decision":
			return http.StatusConflict, "state conflict: binding requires the fresh local Codex claim and exact decision"
		case "state conflict: codex-run already claimed this run":
			return http.StatusConflict, "state conflict: codex-run already claimed this run"
		case "state conflict: codex-run requires an untouched explicit local attempt; inspect the existing run":
			return http.StatusConflict, "state conflict: codex-run requires an untouched explicit local attempt; inspect the existing run"
		case "state conflict: current ready delivery changed or is not reviewable; refresh before marking seen":
			return http.StatusConflict, "state conflict: current ready delivery changed or is not reviewable; refresh before marking seen"
		case "state conflict: decision already recorded":
			return http.StatusConflict, "state conflict: decision already recorded"
		case "state conflict: execution changed; refresh before acting":
			return http.StatusConflict, "state conflict: execution changed; refresh before acting"
		case "state conflict: expected one exact Codex answer":
			return http.StatusConflict, "state conflict: expected one exact Codex answer"
		case "state conflict: follow-up unavailable or already recorded":
			return http.StatusConflict, "state conflict: follow-up unavailable or already recorded"
		case "state conflict: launch notice requires untouched local work":
			return http.StatusConflict, "state conflict: launch notice requires untouched local work"
		case "state conflict: local follow-up marker changed; refresh before acting":
			return http.StatusConflict, "state conflict: local follow-up marker changed; refresh before acting"
		case "state conflict: local follow-up requires the exact current viewed ready report":
			return http.StatusConflict, "state conflict: local follow-up requires the exact current viewed ready report"
		case "state conflict: native start observation requires the untouched initial claim":
			return http.StatusConflict, "state conflict: native start observation requires the untouched initial claim"
		case "state conflict: no open decision":
			return http.StatusConflict, "state conflict: no open decision"
		case "state conflict: observed question/options changed; refresh before choosing":
			return http.StatusConflict, "state conflict: observed question/options changed; refresh before choosing"
		case "state conflict: pinned Codex answer changed or consumed":
			return http.StatusConflict, "state conflict: pinned Codex answer changed or consumed"
		case "state conflict: pinned Codex decision changed or invalid":
			return http.StatusConflict, "state conflict: pinned Codex decision changed or invalid"
		case "state conflict: project_name can only label local work":
			return http.StatusConflict, "state conflict: project_name can only label local work"
		case "state conflict: question already answered in this run; use distinct question wording":
			return http.StatusConflict, "state conflict: question already answered in this run; use distinct question wording"
		case "state conflict: requires the unchanged eligible local failure and an explicit stopped-process confirmation; refresh before creating an attempt":
			return http.StatusConflict, "state conflict: requires the unchanged eligible local failure and an explicit stopped-process confirmation; refresh before creating an attempt"
		case "state conflict: saved task brief changed or is not fresh; no claim consumed":
			return http.StatusConflict, "state conflict: saved task brief changed or is not fresh; no claim consumed"
		}
		return http.StatusConflict, "work changed; refresh before acting"
	}
	switch err.Error() {
	case "answer must match an offered option":
		return http.StatusBadRequest, "answer must match an offered option"
	case "codex binding is only valid for its decision or receipt":
		return http.StatusBadRequest, "codex binding is only valid for its decision or receipt"
	case "codex-run requires an origin of at most 300 characters":
		return http.StatusBadRequest, "codex-run requires an origin of at most 300 characters"
	case "completion requires a labeled HTTP(S) link or inline evidence excerpt":
		return http.StatusBadRequest, "completion requires a labeled HTTP(S) link or inline evidence excerpt"
	case "decision requires a nonblank question and at least two exact-distinct nonblank options of at most 120 characters each":
		return http.StatusBadRequest, "decision requires a nonblank question and at least two exact-distinct nonblank options of at most 120 characters each"
	case "evidence excerpt must be at most 2000 characters":
		return http.StatusBadRequest, "evidence excerpt must be at most 2000 characters"
	case "local follow-up requires end or resume":
		return http.StatusBadRequest, "local follow-up requires end or resume"
	case "local work reports require an origin of at most 300 characters":
		return http.StatusBadRequest, "local work reports require an origin of at most 300 characters"
	case "message is required":
		return http.StatusBadRequest, "message is required"
	case "native start observation requires a valid UUID":
		return http.StatusBadRequest, "native start observation requires a valid UUID"
	case "new attempt event identifier collision; change not saved":
		return http.StatusBadRequest, "new attempt event identifier collision; change not saved"
	case "new attempt identifier collision; change not saved":
		return http.StatusBadRequest, "new attempt identifier collision; change not saved"
	case "project_name change exceeds the existing task readback limit":
		return http.StatusBadRequest, "project_name change exceeds the existing task readback limit"
	case "project_name must be valid text of at most 60 characters":
		return http.StatusBadRequest, "project_name must be valid text of at most 60 characters"
	case "real local work requires a separate blank database without -demo":
		return http.StatusBadRequest, "real local work requires a separate blank database without -demo"
	case "receipt must name an existing command in this run":
		return http.StatusBadRequest, "receipt must name an existing command in this run"
	case "run_id, failed_event_id and confirm_stopped:true are required; verify the old local and external processes have stopped":
		return http.StatusBadRequest, "run_id, failed_event_id and confirm_stopped:true are required; verify the old local and external processes have stopped"
	case "task brief expectation is only valid for a fresh Codex claim":
		return http.StatusBadRequest, "task brief expectation is only valid for a fresh Codex claim"
	case "task exceeds the 1 MiB readback limit; change not saved; shorten the report or use a concise evidence reference":
		return http.StatusBadRequest, "task exceeds the 1 MiB readback limit; change not saved; shorten the report or use a concise evidence reference"
	case "title, goal and origin are required":
		return http.StatusBadRequest, "title, goal and origin are required"
	case "title, goal or origin exceeds its limit (160 / 2000 / 300 characters)":
		return http.StatusBadRequest, "title, goal or origin exceeds its limit (160 / 2000 / 300 characters)"
	case "unsupported action":
		return http.StatusBadRequest, "unsupported action"
	case "unsupported report kind":
		return http.StatusBadRequest, "unsupported report kind"
	}
	return http.StatusInternalServerError, "change could not be saved; refresh and try again"
}

// writeMutationError gives browser clients the same concrete safe message as CLI clients.
func writeMutationError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": message})
}
