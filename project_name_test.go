package main

import (
	"agentworkbench/internal/store"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestProjectNameHTTPExplicitStringOnlyAndExactTask(t *testing.T) {
	x := newCodexHTTPFixture(t, nil)
	post := func(id, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/tasks/"+id+"/project-name", strings.NewReader(body))
		req.Host = "127.0.0.1:8787"
		response := httptest.NewRecorder()
		handler(x.Store).ServeHTTP(response, req)
		return response
	}
	response := post(x.Task.ID, `{"project_name":"  MCP relay  "}`)
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	var named store.Task
	if json.Unmarshal(response.Body.Bytes(), &named) != nil {
		t.Fatal("invalid task response")
	}
	expected := x.Task
	expected.ProjectName = "MCP relay"
	if !reflect.DeepEqual(named, expected) {
		t.Fatal("rename touched execution state")
	}
	for _, body := range []string{`{}`, `null`, `{"project_name":null}`, `{"project_name":12}`, `{"project_name":"","project_id":"demo"}`, `{"project_name":""} {}`, `{"project_name":"` + strings.Repeat("x", 61) + `"}`} {
		rejected := post(x.Task.ID, body)
		if rejected.Code != 400 {
			t.Fatal("invalid/omitted/null rename not rejected", rejected.Code)
		}
		after, _ := x.Store.Get(x.Task.ID)
		if !reflect.DeepEqual(named, after) {
			t.Fatal("invalid payload cleared or changed task")
		}
	}
	if missing := post("missing-task", `{"project_name":"AMC"}`); missing.Code != 404 {
		t.Fatal(missing.Code)
	}
	if clear := post(x.Task.ID, `{"project_name":""}`); clear.Code != 200 {
		t.Fatal(clear.Code)
	}
	cleared, _ := x.Store.Get(x.Task.ID)
	if !reflect.DeepEqual(x.Task, cleared) {
		t.Fatal("explicit empty did not solely clear metadata")
	}
}

func TestProjectNameHTTPCreateAndDemoRefusal(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "create.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	create := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{"title":"Fixture","goal":"Explicit scope","origin":"fixture","project_name":"  Workbench  "}`))
	create.Host = "127.0.0.1:8787"
	response := httptest.NewRecorder()
	handler(s).ServeHTTP(response, create)
	var task store.Task
	if response.Code != 201 || json.Unmarshal(response.Body.Bytes(), &task) != nil || task.ProjectName != "Workbench" || task.ProjectID != "local" {
		t.Fatal("create did not preserve display/internal separation", response.Code)
	}
	demo, err := store.Open(filepath.Join(t.TempDir(), "demo.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer demo.Close()
	if err = demo.Seed(); err != nil {
		t.Fatal(err)
	}
	before, _ := demo.Get("t4")
	req := httptest.NewRequest("POST", "/api/tasks/t4/project-name", strings.NewReader(`{"project_name":"AMC"}`))
	req.Host = "127.0.0.1:8787"
	rejected := httptest.NewRecorder()
	handler(demo).ServeHTTP(rejected, req)
	after, _ := demo.Get("t4")
	if rejected.Code != 409 || !reflect.DeepEqual(before, after) {
		t.Fatal("demo endpoint changed task", rejected.Code)
	}
}
