package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

const managedBodyLimit = 6 << 20      // legacy task creation
const managedTurnBodyLimit = 18 << 20 // three base64 screenshots plus text

type managedImageInput struct {
	Mime string `json:"mime_type"`
	Data string `json:"data_base64"`
}

type managedPartInput struct {
	Text  *string            `json:"text"`
	Image *managedImageInput `json:"image"`
}

func validatedManagedParts(in []managedPartInput) ([]store.ManagedPartInput, string, error) {
	if in == nil {
		return nil, "", nil
	}
	if len(in) == 0 || len(in) > store.MaxManagedParts {
		return nil, "", store.ErrManagedParts
	}
	images, chars := 0, 0
	var plain strings.Builder
	for _, p := range in {
		switch {
		case p.Text != nil && p.Image == nil:
			chars += utf8.RuneCountInString(*p.Text)
			if *p.Text == "" || chars > 2000 || !utf8.ValidString(*p.Text) {
				return nil, "", store.ErrManagedParts
			}
			plain.WriteString(*p.Text)
		case p.Image != nil && p.Text == nil:
			images++
			if images > store.MaxManagedImages {
				return nil, "", store.ErrManagedParts
			}
		default:
			return nil, "", store.ErrManagedParts
		}
	}
	text := strings.TrimSpace(plain.String())
	if text == "" && images == 0 {
		return nil, "", store.ErrManagedParts
	}
	result := make([]store.ManagedPartInput, 0, len(in))
	for _, p := range in {
		if p.Text != nil {
			result = append(result, store.ManagedPartInput{Text: *p.Text})
			continue
		}
		img, err := validatedManagedImage(p.Image)
		if err != nil {
			return nil, "", err
		}
		result = append(result, store.ManagedPartInput{Image: img})
	}
	return result, text, nil
}

func validatedManagedImage(in *managedImageInput) (*store.ManagedImage, error) {
	if in == nil {
		return nil, nil
	}
	bad := errors.New("图片须是完整的 PNG 或 JPEG，不超过 4 MiB，边长不超过 4096，且不超过 1200 万像素。")
	if (in.Mime != "image/png" && in.Mime != "image/jpeg") || len(in.Data) > base64.StdEncoding.EncodedLen(store.MaxManagedImageBytes) || strings.ContainsAny(in.Data, "\r\n") {
		return nil, bad
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(in.Data)
	if err != nil || len(raw) == 0 || len(raw) > store.MaxManagedImageBytes {
		return nil, bad
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || "image/"+format != in.Mime || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > 4096 || cfg.Height > 4096 || cfg.Width*cfg.Height > 12_000_000 {
		return nil, bad
	}
	img, actual, err := image.Decode(bytes.NewReader(raw))
	if err != nil || actual != format || img.Bounds().Dx() != cfg.Width || img.Bounds().Dy() != cfg.Height {
		return nil, bad
	}
	return &store.ManagedImage{Mime: in.Mime, Bytes: raw}, nil
}

func managedLocal(r *http.Request) bool {
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || !net.ParseIP(remote).IsLoopback() {
		return false
	}
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = strings.Trim(r.Host, "[]")
	}
	return host == "localhost" || net.ParseIP(host).IsLoopback()
}

func managedBrowser(r *http.Request) bool {
	return managedLocal(r) && r.Header.Get("Origin") == "http://"+r.Host
}

func managedJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readManagedJSON(w http.ResponseWriter, r *http.Request, in any) (int, string) {
	return readBoundedJSON(w, r, in, managedTurnBodyLimit)
}

func readBoundedJSON(w http.ResponseWriter, r *http.Request, in any, limit int64) (int, string) {
	media, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if media != "application/json" {
		return http.StatusUnsupportedMediaType, "需要 application/json。"
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(in); err != nil {
		var tooBig *http.MaxBytesError
		if errors.As(err, &tooBig) {
			return http.StatusRequestEntityTooLarge, "请求过大。"
		}
		return http.StatusBadRequest, "请求格式无效。"
	}
	var trailing any
	if err := dec.Decode(&trailing); err != io.EOF {
		return http.StatusBadRequest, "只可提交一个 JSON 对象。"
	}
	return 0, ""
}

type managedPartView struct {
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"image_url,omitempty"`
}

func managedPartViews(task string, parts []store.ManagedPart) []managedPartView {
	var result []managedPartView
	for _, p := range parts {
		if p.ImageSlot != "" {
			result = append(result, managedPartView{ImageURL: managedImageLink(task, p.ImageSlot)})
		} else {
			result = append(result, managedPartView{Text: p.Text})
		}
	}
	return result
}

type managedTurnView struct {
	Parts    []managedPartView `json:"parts,omitempty"`
	ID       string            `json:"id"`
	Kind     string            `json:"kind"`
	Message  string            `json:"message"`
	State    string            `json:"state"`
	ImageURL string            `json:"image_url,omitempty"`
	Reply    string            `json:"reply,omitempty"`
}
type managedView struct {
	InitialParts    []managedPartView `json:"initial_parts,omitempty"`
	Mode            string            `json:"mode,omitempty"`
	Enabled         bool              `json:"enabled"`
	Managed         bool              `json:"managed"`
	RunID           string            `json:"run_id"`
	CanStart        bool              `json:"can_start"`
	CanFollowUp     bool              `json:"can_follow_up"`
	InitialImageURL string            `json:"initial_image_url,omitempty"`
	Turns           []managedTurnView `json:"turns"`
}

func managedImageLink(task, slot string) string {
	return "/api/tasks/" + url.PathEscape(task) + "/managed/images/" + url.PathEscape(slot)
}
func managedReadView(s *store.Store, worker *managedWorker, id string) (managedView, error) {
	t, state, err := s.ManagedSnapshot(id)
	if err != nil {
		return managedView{}, err
	}
	v := managedView{Enabled: worker != nil, RunID: t.RunID, Turns: []managedTurnView{}}
	if worker != nil {
		v.Mode = worker.mode()
	}
	if state == nil {
		return v, nil
	}
	if state.HasInitial {
		v.InitialImageURL = managedImageLink(id, "initial")
	}
	v.InitialParts = managedPartViews(id, state.InitialParts)
	v.Managed = len(state.Turns) != 0
	if worker != nil {
		v.CanStart, v.CanFollowUp = state.Available(t, worker.runner, worker.owner)
		if worker.noSandbox && strings.TrimSpace(t.Goal) == "" {
			v.CanStart = false
		}
	}
	for _, turn := range state.Turns {
		item := managedTurnView{ID: turn.ID, Kind: turn.Kind, Message: turn.Message, State: turn.State, Reply: turn.Reply, Parts: managedPartViews(id, turn.Parts)}
		if turn.ImageDigest != "" {
			item.ImageURL = managedImageLink(id, turn.ID)
		}
		if (item.State == "pending" || item.State == "running") && (worker == nil || turn.Owner != worker.owner || state.Runner != worker.runner || state.RunID != t.RunID) {
			item.State, item.Reply = "uncertain", "当前服务无法核实这轮回执，不会自动重发。"
		}
		v.Turns = append(v.Turns, item)
	}
	return v, nil
}

func registerManaged(m *http.ServeMux, s *store.Store, worker *managedWorker) {
	const path = "/api/tasks/{id}/managed"
	show := func(w http.ResponseWriter, id string) {
		v, err := managedReadView(s, worker, id)
		if err != nil {
			managedWriteError(w, err)
			return
		}
		managedJSON(w, http.StatusOK, v)
	}
	m.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
		if !managedLocal(r) {
			writeMutationError(w, "loopback client required", http.StatusForbidden)
			return
		}
		show(w, r.PathValue("id"))
	})
	m.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
		if !managedBrowser(r) {
			writeMutationError(w, "same-origin local browser required", http.StatusForbidden)
			return
		}
		if worker == nil {
			writeMutationError(w, "本机没有配置卡内 Codex 执行。", http.StatusServiceUnavailable)
			return
		}
		var in struct {
			Parts   []managedPartInput `json:"parts"`
			Mode    string             `json:"mode"`
			Action  string             `json:"action"`
			ID      string             `json:"request_id"`
			RunID   string             `json:"run_id"`
			Message string             `json:"message"`
			Image   *managedImageInput `json:"image"`
		}
		if code, message := readManagedJSON(w, r, &in); code != 0 {
			writeMutationError(w, message, code)
			return
		}
		if in.RunID == "" || len(in.RunID) > 250 || !managedRequestID(in.ID) ||
			!utf8.ValidString(in.Message) || utf8.RuneCountInString(in.Message) > 2000 ||
			(in.Action != "start" && in.Action != "follow_up") ||
			(in.Action == "start" && (strings.TrimSpace(in.Message) != "" || in.Image != nil || in.Parts != nil)) ||
			(in.Parts != nil && (in.Image != nil || in.Message != "")) ||
			(in.Action == "follow_up" && strings.TrimSpace(in.Message) == "" && in.Image == nil && in.Parts == nil) {
			writeMutationError(w, "缺少当前执行编号、请求编号，或指示为空/超过 2000 字。", http.StatusBadRequest)
			return
		}
		if (in.Mode != "" || worker.noSandbox) && in.Mode != worker.mode() {
			writeMutationError(w, "Codex 执行模式未确认或已变化。请刷新此卡，核对模式后再操作。", http.StatusConflict)
			return
		}
		id := r.PathValue("id")
		if worker.noSandbox {
			if in.Action == "start" {
				task, _, err := s.ManagedSnapshot(id)
				if err != nil {
					managedWriteError(w, err)
					return
				}
				if strings.TrimSpace(task.Goal) == "" {
					writeMutationError(w, "无沙箱模式须有明确的文字指示；截图只能作为参考。", http.StatusConflict)
					return
				}
			}
		}
		parts, text, err := validatedManagedParts(in.Parts)
		if err != nil {
			writeMutationError(w, err.Error(), http.StatusBadRequest)
			return
		}
		if worker.noSandbox && in.Action == "follow_up" && strings.TrimSpace(in.Message) == "" && text == "" {
			writeMutationError(w, "无沙箱模式须有明确的文字指示；截图只能作为参考。", http.StatusConflict)
			return
		}
		img, err := validatedManagedImage(in.Image)
		if err != nil {
			writeMutationError(w, err.Error(), http.StatusBadRequest)
			return
		}
		added, err := s.QueueManaged(id, worker.runner, worker.owner, store.ManagedInput{ID: in.ID, RunID: in.RunID, Kind: in.Action, Message: in.Message, Image: img, Parts: parts})
		if err != nil {
			managedWriteError(w, err)
			return
		}
		if added {
			// The transactional receipt, not the connection's lifetime,
			// authorizes this one turn. Losing the response does not replay it.
			go worker.drain(s, id)
		}
		show(w, id)
	})
	m.HandleFunc("GET "+path+"/images/{slot}", func(w http.ResponseWriter, r *http.Request) {
		if !managedLocal(r) {
			http.Error(w, "loopback client required", http.StatusForbidden)
			return
		}
		slot := r.PathValue("slot")
		if !store.ValidManagedImageSlot(slot) {
			http.NotFound(w, r)
			return
		}
		img, err := s.ManagedImage(r.PathValue("id"), slot)
		if err != nil || (img.Mime != "image/png" && img.Mime != "image/jpeg") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", img.Mime)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(img.Bytes)
	})
}

func managedRequestID(id string) bool {
	return id != "initial" && store.ValidManagedRequestID(id)
}

func managedWriteError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		writeMutationError(w, "事项不存在。", http.StatusNotFound)
	case errors.Is(err, store.ErrConflict):
		writeMutationError(w, strings.TrimPrefix(err.Error(), "state conflict: "), http.StatusConflict)
	default:
		writeMutationError(w, "无法核实请求是否已保存；请先刷新原卡，不要改用新的请求编号。", http.StatusInternalServerError)
	}
}
