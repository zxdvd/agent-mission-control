package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image/color"
	"mime"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

const composerPost = "/api/tasks/compose"
const composerOrigin = "http://127.0.0.1:18819"

func composeTask(t *testing.T, h http.Handler, payload any) store.Task {
	t.Helper()
	rec := managedRequest(t, h, http.MethodPost, composerPost, composerOrigin, payload)
	var card store.Task
	if rec.Code != http.StatusCreated || json.Unmarshal(rec.Body.Bytes(), &card) != nil || card.ID == "" {
		t.Fatalf("wanted a saved card, got %d %s", rec.Code, rec.Body.String())
	}
	return card
}

func TestTaskComposerSaveOnlyExactAttachmentsAndReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "workbench.db")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Intentionally no execution function: create must not dispatch or queue.
	worker := &managedWorker{runner: "synthetic", owner: "test"}
	h := handlerWithManaged(s, worker)
	png := managedPNG(t, color.RGBA{R: 254, A: 255})
	saved := []byte("opaque fixture contents\n")
	card := composeTask(t, h, map[string]any{
		"goal": "  查看截图  内容\r\n保留这一行。  ", "project_name": "  Workbench ",
		"image":       managedTestImage(png),
		"attachments": []taskAttachmentInput{{Name: "记录.html", Data: base64.StdEncoding.EncodeToString(saved)}},
	})
	if card.Goal != "查看截图  内容\r\n保留这一行。" || card.Title != "查看截图 内容" ||
		card.Source != "local" || card.Origin != store.WorkbenchCreateOrigin || card.ProjectName != "Workbench" ||
		card.Status != "not_started" || len(card.Commands) != 0 || len(card.Events) != 1 || card.Events[0].Kind != "local_created" || card.Events[0].Origin != card.Origin ||
		len(card.Attachments) != 1 || card.Attachments[0] != (store.TaskAttachmentInfo{Name: "记录.html", Size: len(saved)}) {
		t.Fatalf("got unexpected card %+v", card)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h = handlerWithManaged(s, worker)
	view := managedTestView(t, managedRequest(t, h, http.MethodGet, "/api/tasks/"+card.ID+"/managed", "", nil))
	if view.Managed || !view.CanStart || len(view.Turns) != 0 || view.InitialImageURL == "" {
		t.Fatalf("unexpected managed state %+v", view)
	}
	image := managedRequest(t, h, http.MethodGet, view.InitialImageURL, "", nil)
	if image.Code != http.StatusOK || image.Header().Get("Content-Type") != "image/png" || !bytes.Equal(image.Body.Bytes(), png) {
		t.Fatalf("screenshot changed after restart: %d", image.Code)
	}
	list := managedRequest(t, h, http.MethodGet, "/api/tasks", "", nil)
	if list.Code != http.StatusOK || strings.Contains(list.Body.String(), "data_base64") || strings.Contains(list.Body.String(), string(saved)) ||
		!strings.Contains(list.Body.String(), "记录.html") {
		t.Fatalf("list should contain file metadata only: %d %s", list.Code, list.Body.String())
	}
	filePath := "/api/tasks/" + card.ID + "/attachments/1"
	file := managedRequest(t, h, http.MethodGet, filePath, "", nil)
	disp, args, err := mime.ParseMediaType(file.Header().Get("Content-Disposition"))
	if file.Code != http.StatusOK || !bytes.Equal(file.Body.Bytes(), saved) || disp != "attachment" || args["filename"] != "记录.html" ||
		file.Header().Get("Content-Type") != "application/octet-stream" || file.Header().Get("X-Content-Type-Options") != "nosniff" ||
		file.Header().Get("Cache-Control") != "no-store" || file.Header().Get("Cross-Origin-Resource-Policy") != "same-origin" || err != nil {
		t.Fatalf("unexpected local download %d %v %v", file.Code, file.Header(), err)
	}
	for _, remote := range []struct{ addr, site string }{{"127.0.0.1:3000", "cross-site"}, {"203.0.113.1:3000", ""}} {
		req := httptest.NewRequest(http.MethodGet, filePath, nil)
		req.Host, req.RemoteAddr = "127.0.0.1:18819", remote.addr
		req.Header.Set("Sec-Fetch-Site", remote.site)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("untrusted download accepted: %+v %d", remote, rec.Code)
		}
	}
	for _, wrongPath := range []string{"/api/tasks/" + card.ID + "/attachments/2", "/api/tasks/" + card.ID + "/attachments/4", "/api/tasks/not-the-card/attachments/1"} {
		if rec := managedRequest(t, h, http.MethodGet, wrongPath, "", nil); rec.Code != http.StatusNotFound {
			t.Fatalf("unexpected download %s: %d", wrongPath, rec.Code)
		}
	}
}

func TestTaskComposerImageOrFileOnlyAndLegacyCompatibility(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "workbench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	worker := &managedWorker{runner: "synthetic", owner: "test"}
	h := handlerWithManaged(s, worker)
	imageOnly := composeTask(t, h, map[string]any{"image": managedTestImage(managedPNG(t, color.RGBA{R: 111, A: 255}))})
	fileOnly := composeTask(t, h, map[string]any{"attachments": []taskAttachmentInput{{Name: "local.txt", Data: "YQ=="}}})
	for _, x := range []struct {
		card     store.Task
		title    string
		canStart bool
	}{{imageOnly, "图片任务", true}, {fileOnly, "附件任务", false}} {
		v := managedTestView(t, managedRequest(t, h, http.MethodGet, "/api/tasks/"+x.card.ID+"/managed", "", nil))
		if store.ValidFreshTaskBrief(x.card) || x.card.Goal != "" || x.card.Title != x.title || v.CanStart != x.canStart || v.Managed || len(v.Turns) != 0 {
			t.Fatalf("incorrect attachment-only behavior: %+v %+v", x.card, v)
		}
	}
	composite := strings.Repeat("测", 90)
	textOnly := composeTask(t, h, map[string]string{"goal": composite + "\n完整目标"})
	if textOnly.Title != strings.Repeat("测", 71)+"…" || textOnly.Goal != composite+"\n完整目标" || !store.ValidFreshTaskBrief(textOnly) {
		t.Fatalf("incorrect text task: %+v", textOnly)
	}
	legacy := managedRequest(t, h, http.MethodPost, "/api/tasks", "", map[string]string{"title": "legacy title", "goal": "legacy goal", "origin": "CLI", "project_name": "old"})
	var legacyCard store.Task
	if legacy.Code != http.StatusCreated || json.Unmarshal(legacy.Body.Bytes(), &legacyCard) != nil ||
		legacyCard.Title != "legacy title" || legacyCard.Origin != "CLI" || legacyCard.ProjectName != "old" {
		t.Fatalf("legacy text clients changed: %d %s", legacy.Code, legacy.Body.String())
	}
}

func TestTaskComposerRejectsInvalidInputsWithoutSavingAnyPortion(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "workbench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h := handler(s)
	for _, x := range []struct {
		name    string
		origin  string
		payload any
		status  int
	}{
		{"empty", composerOrigin, map[string]any{"goal": "   "}, 400},
		{"client title and source not accepted", composerOrigin, map[string]any{"goal": "work", "title": "manual", "origin": "spoofed"}, 400},
		{"goal limit", composerOrigin, map[string]any{"goal": strings.Repeat("测", 2001)}, 400},
		{"bad encoding", composerOrigin, map[string]any{"goal": "work", "attachments": []taskAttachmentInput{{Name: "valid", Data: "YQ=="}, {Name: "bad", Data: "?"}}}, 400},
		{"bad name", composerOrigin, map[string]any{"goal": "work", "attachments": []taskAttachmentInput{{Name: "../bad", Data: "YQ=="}}}, 400},
		{"empty file", composerOrigin, map[string]any{"goal": "work", "attachments": []taskAttachmentInput{{Name: "empty"}}}, 400},
		{"too many files", composerOrigin, map[string]any{"goal": "work", "attachments": make([]taskAttachmentInput, 4)}, 400},
		{"oversize file", composerOrigin, map[string]any{"goal": "work", "attachments": []taskAttachmentInput{{Name: "huge", Data: base64.StdEncoding.EncodeToString(make([]byte, store.MaxTaskAttachmentBytes+1))}}}, 400},
		{"bogus image", composerOrigin, map[string]any{"goal": "work", "image": managedTestImage([]byte("not a PNG"))}, 400},
		{"cross origin", "https://other.test", map[string]any{"goal": "work"}, 403},
		{"non-browser upload", "", map[string]any{"attachments": []taskAttachmentInput{{Name: "valid", Data: "YQ=="}}}, 403},
	} {
		t.Run(x.name, func(t *testing.T) {
			rec := managedRequest(t, h, http.MethodPost, composerPost, x.origin, x.payload)
			if rec.Code != x.status {
				t.Fatalf("wanted %d; got %d %s", x.status, rec.Code, rec.Body.String())
			}
			if cards, err := s.List(); err != nil || len(cards) != 0 {
				t.Fatalf("rejected create wrote a task: %+v %v", cards, err)
			}
		})
	}
}
