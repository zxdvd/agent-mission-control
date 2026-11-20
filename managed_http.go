package main

import (
	"agentworkbench/internal/store"
	"bytes"
	"crypto/subtle"
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

const managedBodyLimit = 6 << 20

type managedImageInput struct {
	Mime string `json:"mime_type"`
	Data string `json:"data_base64"`
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
	return readBoundedJSON(w, r, in, managedBodyLimit)
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

type managedTurnView struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Message  string `json:"message"`
	State    string `json:"state"`
	ImageURL string `json:"image_url,omitempty"`
	Reply    string `json:"reply,omitempty"`
}
type managedView struct {
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
	v.Managed = len(state.Turns) != 0
	if worker != nil {
		v.CanStart, v.CanFollowUp = state.Available(t, worker.runner, worker.owner)
		if worker.noSandbox && state.HasInitial {
			v.CanStart = false
		}
	}
	for _, turn := range state.Turns {
		item := managedTurnView{ID: turn.ID, Kind: turn.Kind, Message: turn.Message, State: turn.State, Reply: turn.Reply}
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
			(in.Action == "start" && (strings.TrimSpace(in.Message) != "" || in.Image != nil)) ||
			(in.Action == "follow_up" && strings.TrimSpace(in.Message) == "" && in.Image == nil) {
			writeMutationError(w, "缺少当前执行编号、请求编号，或指示为空/超过 2000 字。", http.StatusBadRequest)
			return
		}
		if (in.Mode != "" || worker.noSandbox) && in.Mode != worker.mode() {
			writeMutationError(w, "Codex 执行模式未确认或已变化。请刷新此卡，核对模式后再操作。", http.StatusConflict)
			return
		}
		id := r.PathValue("id")
		if worker.noSandbox {
			code := r.Header.Get("X-Workbench-Run-Code")
			if worker.runCode == "" || subtle.ConstantTimeCompare([]byte(code), []byte(worker.runCode)) != 1 {
				writeMutationError(w, "无沙箱执行码有误或已过期。请输入当前工作台启动终端里的执行码。", http.StatusForbidden)
				return
			}
			if in.Action == "start" {
				task, state, err := s.ManagedSnapshot(id)
				if err != nil {
					managedWriteError(w, err)
					return
				}
				if strings.TrimSpace(task.Goal) == "" || (state != nil && state.HasInitial) {
					writeMutationError(w, "无沙箱模式仅处理文字任务。请新建不含截图的文字事项，或重启工作台使用只读模式。", http.StatusConflict)
					return
				}
			} else if in.Image != nil {
				writeMutationError(w, "无沙箱模式不发送截图。请只提交文字补充。", http.StatusConflict)
				return
			}
		}
		img, err := validatedManagedImage(in.Image)
		if err != nil {
			writeMutationError(w, err.Error(), http.StatusBadRequest)
			return
		}
		added, err := s.QueueManaged(id, worker.runner, worker.owner, store.ManagedInput{ID: in.ID, RunID: in.RunID, Kind: in.Action, Message: in.Message, Image: img})
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
		if slot != "initial" && !managedRequestID(slot) {
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
