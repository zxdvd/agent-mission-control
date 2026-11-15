package herdr

import (
	"encoding/json"
	"testing"
)

func TestObservationsAllowlist(t *testing.T) {
	for _, raw := range []string{
		`{"agents":[{"pane_id":"w1:p1","agent_status":"working","cwd":"/not-for-display","tokens":{"secret":"not-for-display"}}]}`,
		`{"result":{"type":"agent_list","agents":[{"pane_id":"w1:p1","agent_status":"working"}]}}`,
	} {
		entries, err := Observations(json.RawMessage(raw))
		if err != nil || len(entries) != 1 || entries[0] != (Entry{"w1:p1", "working"}) {
			t.Fatalf("%v %v", entries, err)
		}
	}
	for _, raw := range []string{`{}`, `{"agents":null}`, `{"agents":[{}]}`} {
		if _, err := Observations(json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if entries, err := Observations(json.RawMessage(`{"agents":[]}`)); err != nil || entries == nil || len(entries) != 0 {
		t.Fatalf("%v %v", entries, err)
	}
}
