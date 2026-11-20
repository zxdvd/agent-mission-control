package main

import (
	"agentworkbench/internal/store"
	"encoding/base64"
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

// Up to three managed images plus three local files, base64 and metadata.
const composerBodyLimit = 26 << 20

type taskAttachmentInput struct {
	Name string `json:"name"`
	Data string `json:"data_base64"`
}

func registerTaskComposer(m *http.ServeMux, s *store.Store) {
	m.HandleFunc("POST /api/tasks/compose", func(w http.ResponseWriter, r *http.Request) {
		if !managedBrowser(r) {
			writeMutationError(w, "same-origin local browser required", http.StatusForbidden)
			return
		}
		var in struct {
			Parts       []managedPartInput    `json:"parts"`
			Goal        string                `json:"goal"`
			ProjectName string                `json:"project_name"`
			Image       *managedImageInput    `json:"image"`
			Attachments []taskAttachmentInput `json:"attachments"`
		}
		if code, message := readBoundedJSON(w, r, &in, composerBodyLimit); code != 0 {
			writeMutationError(w, message, code)
			return
		}
		if len(in.Attachments) > store.MaxTaskAttachments {
			writeMutationError(w, store.ErrTaskAttachments.Error(), http.StatusBadRequest)
			return
		}
		if in.Parts != nil && (in.Image != nil || in.Goal != "") {
			writeMutationError(w, store.ErrManagedParts.Error(), http.StatusBadRequest)
			return
		}
		parts, _, err := validatedManagedParts(in.Parts)
		if err != nil {
			writeMutationError(w, err.Error(), http.StatusBadRequest)
			return
		}
		image, err := validatedManagedImage(in.Image)
		if err != nil {
			writeMutationError(w, err.Error(), http.StatusBadRequest)
			return
		}
		local := make([]store.TaskAttachment, 0, len(in.Attachments))
		for _, item := range in.Attachments {
			if len(item.Data) > base64.StdEncoding.EncodedLen(store.MaxTaskAttachmentBytes) || strings.ContainsAny(item.Data, "\r\n") {
				writeMutationError(w, store.ErrTaskAttachments.Error(), http.StatusBadRequest)
				return
			}
			b, err := base64.StdEncoding.Strict().DecodeString(item.Data)
			if err != nil {
				writeMutationError(w, store.ErrTaskAttachments.Error(), http.StatusBadRequest)
				return
			}
			local = append(local, store.TaskAttachment{Name: item.Name, Bytes: b})
		}
		var task store.Task
		if parts == nil {
			task, err = s.ComposeTask(in.Goal, in.ProjectName, image, local)
		} else {
			task, err = s.ComposeTaskParts(in.ProjectName, parts, local)
		}
		if err != nil {
			switch {
			case errors.Is(err, store.ErrEmptyTaskComposer), errors.Is(err, store.ErrLongTaskComposer), errors.Is(err, store.ErrTaskAttachments), errors.Is(err, store.ErrManagedParts):
				writeMutationError(w, err.Error(), http.StatusBadRequest)
			default:
				code, message := safeMutationError(err)
				writeMutationError(w, message, code)
			}
			return
		}
		managedJSON(w, http.StatusCreated, task)
	})

	m.HandleFunc("GET /api/tasks/{id}/attachments/{position}", func(w http.ResponseWriter, r *http.Request) {
		site := r.Header.Get("Sec-Fetch-Site")
		if !managedLocal(r) || (site != "" && site != "same-origin" && site != "none") {
			http.Error(w, "same-origin local download required", http.StatusForbidden)
			return
		}
		position, err := strconv.Atoi(r.PathValue("position"))
		if err != nil || position < 1 || position > store.MaxTaskAttachments {
			http.NotFound(w, r)
			return
		}
		file, err := s.TaskAttachment(r.PathValue("id"), position)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		// Never serve an attachment inline, regardless of its declared name or contents.
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": file.Name}))
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(file.Bytes)
	})
}
