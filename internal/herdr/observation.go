package herdr

import (
	"encoding/json"
	"errors"
)

// Entry is display-only. Native session values, working directories and
// arbitrary terminal metadata are deliberately not returned by this view.
type Entry struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type agentList struct {
	Agents []struct {
		PaneID string `json:"pane_id"`
		Status string `json:"agent_status"`
	} `json:"agents"`
}

// Observations maps Herdr's agent.list response. CLI output can be the result
// itself or the JSON-RPC envelope. A missing list isn't a verified empty list.
func Observations(data json.RawMessage) ([]Entry, error) {
	var envelope struct {
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}
	if len(envelope.Result) > 0 {
		data = envelope.Result
	}
	var list agentList
	if err := json.Unmarshal(data, &list); err != nil {
		return nil, err
	}
	if list.Agents == nil {
		return nil, errors.New("unsupported Herdr agent list shape")
	}
	out := make([]Entry, 0, len(list.Agents))
	for _, a := range list.Agents {
		if a.PaneID == "" {
			return nil, errors.New("Herdr agent has no pane ID")
		}
		s := a.Status
		switch s {
		case "idle", "working", "blocked", "done", "unknown":
		default:
			s = "unknown"
		}
		out = append(out, Entry{a.PaneID, s})
	}
	return out, nil
}
