package main

import (
	"agentworkbench/internal/store"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoopback(t *testing.T) {
	for _, a := range []string{"0.0.0.0:8787", ":8787", "example.com:8787"} {
		if loopback(a) {
			t.Fatal(a)
		}
	}
	if !loopback("127.0.0.1:8787") {
		t.Fatal("loopback rejected")
	}
}
func TestHTTP(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.Seed()
	h := handler(s)
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{{"GET", "/api/tasks", "", 200}, {"POST", "/api/tasks/t3/follow-up", `{"run_id":"wrong"}`, 409}, {"POST", "/api/tasks/t3/follow-up", `{"run_id":"t3-run-1"}`, 200}, {"POST", "/api/tasks/t3/follow-up", `{"run_id":"t3-run-1"}`, 409}, {"POST", "/api/tasks/t1/reports", `{`, 400}} {
		r := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		r.Host = "127.0.0.1:8787"
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("%s: %d %s", tc.path, w.Code, w.Body.String())
		}
	}
}

func TestCrossOriginMutationRefused(t *testing.T) {
	s, e := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	s.Seed()
	r := httptest.NewRequest("POST", "/api/tasks/t3/follow-up", strings.NewReader(`{"run_id":"t3-run-1"}`))
	r.Host = "127.0.0.1:8787"
	r.Header.Set("Origin", "https://other.test")
	w := httptest.NewRecorder()
	handler(s).ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
}
