package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestFollowUpHTTPRecordsExactDeliveryWithoutChangingTask(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	ready, err := x.Store.Apply(x.Task.ID, "reports", store.Input{RunID: x.Task.RunID, Kind: "ready", Message: "Original result", Origin: "fixture", Evidence: []store.Evidence{{Excerpt: "Original verification"}}})
	if err != nil {
		t.Fatal(err)
	}
	report := store.CurrentReadyReportID(ready)
	ready, err = x.Store.ReviewDelivery(ready.ID, ready.RunID, report)
	if err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/tasks/" + ready.ID + "/follow-ups"
	app := handler(x.Store)
	request := func(method, origin, media string, payload []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, endpoint, bytes.NewReader(payload))
		req.Host, req.RemoteAddr = "127.0.0.1:8787", "127.0.0.1:32957"
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if media != "" {
			req.Header.Set("Content-Type", media)
		}
		res := httptest.NewRecorder()
		app.ServeHTTP(res, req)
		return res
	}
	const origin = "http://127.0.0.1:8787"
	const media = "application/json"
	in := store.FollowUpInput{RequestID: "fixed-request-id", RunID: ready.RunID, ReportEventID: report, Kind: "adjust", Message: "补一个失败场景的测试"}
	b, _ := json.Marshal(in)
	for _, check := range []struct {
		origin, media string
		body          []byte
		code          int
	}{
		{"", media, b, http.StatusForbidden},
		{"http://other.test", media, b, http.StatusForbidden},
		{origin, "text/plain", b, http.StatusUnsupportedMediaType},
		{origin, media, append([]byte(`{"cwd":"/tmp",`), b[1:]...), http.StatusBadRequest},
		{origin, media, append([]byte(`{"kind":"explain",`), b[1:]...), http.StatusBadRequest},
		{origin, media, append([]byte(`{"message":null,`), b[1:]...), http.StatusBadRequest},
	} {
		if got := request(http.MethodPost, check.origin, check.media, check.body); got.Code != check.code {
			t.Fatalf("got %d want %d: %s", got.Code, check.code, got.Body.String())
		}
	}
	for i := 0; i < 2; i++ {
		res := request(http.MethodPost, origin, media, b)
		if res.Code != http.StatusOK || !strings.Contains(res.Body.String(), `"state":"pending"`) || strings.Contains(res.Body.String(), `"snapshot"`) || strings.Contains(res.Body.String(), `"claim_id"`) {
			t.Fatal(res.Code, res.Body.String())
		}
	}
	res := request(http.MethodGet, "", "", nil)
	var results []followUpView
	if res.Code != http.StatusOK || json.Unmarshal(res.Body.Bytes(), &results) != nil || len(results) != 1 || results[0].FollowUpInput != in {
		t.Fatal(res.Code, res.Body.String())
	}
	updated, err := x.Store.Get(ready.ID)
	if err != nil || !reflect.DeepEqual(updated, ready) {
		t.Fatalf("original task changed: %#v, %v", updated, err)
	}
}
