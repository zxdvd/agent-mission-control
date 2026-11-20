package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

const MaxManagedImageBytes = 4 << 20
const MaxManagedImages = 3
const MaxManagedParts = 16
const managedTurnLimit = 20
const managedOrigin = "由 Workbench 显式启动的 Codex；执行者声明的证据，未经独立验收。"

type ManagedImage struct {
	Mime  string
	Bytes []byte
}

// Managed state is private server data. HTTP responses use an explicit
// projection and never reveal the runner, instance marker or native UUID.
type ManagedState struct {
	RunID        string
	ThreadID     string
	Runner       string
	HasInitial   bool // legacy single screenshot
	InitialParts []ManagedPart
	Turns        []ManagedTurn
}

type ManagedTurn struct {
	ID          string
	Kind        string
	Message     string
	State       string
	Owner       string
	ImageDigest string // legacy single screenshot
	Parts       []ManagedPart
	Reply       string
}

type ManagedInput struct {
	ID, Kind, Message, RunID string
	Image                    *ManagedImage
	Parts                    []ManagedPartInput
}

// ManagedPart stores only ordered text/asset references, not image bytes.
// Digests bind exact duplicate requests and are not exposed to the browser.
type ManagedPart struct {
	Text, ImageSlot, Digest string
}

type ManagedPartInput struct {
	Text  string
	Image *ManagedImage
}

var ErrManagedParts = errors.New("一条消息最多 3 张截图和 2000 字。文字和截图须按顺序提交。")

func managedImageDigest(img *ManagedImage) string {
	d := sha256.Sum256(img.Bytes)
	return img.Mime + ":" + hex.EncodeToString(d[:])
}

func makeManagedParts(prefix string, in []ManagedPartInput) (parts []ManagedPart, text string, imgs int, err error) {
	if (in != nil && len(in) == 0) || len(in) > MaxManagedParts {
		return nil, "", 0, ErrManagedParts
	}
	var plain strings.Builder
	chars := 0
	for _, part := range in {
		if part.Image == nil {
			chars += utf8.RuneCountInString(part.Text)
			if part.Text == "" || !utf8.ValidString(part.Text) || chars > 2000 {
				return nil, "", 0, ErrManagedParts
			}
			plain.WriteString(part.Text)
			parts = append(parts, ManagedPart{Text: part.Text})
			continue
		}
		imgs++
		if part.Text != "" || imgs > MaxManagedImages ||
			(part.Image.Mime != "image/png" && part.Image.Mime != "image/jpeg") ||
			len(part.Image.Bytes) == 0 || len(part.Image.Bytes) > MaxManagedImageBytes {
			return nil, "", 0, ErrManagedParts
		}
		parts = append(parts, ManagedPart{ImageSlot: fmt.Sprintf("~%s:%d", prefix, imgs), Digest: managedImageDigest(part.Image)})
	}
	return parts, strings.TrimSpace(plain.String()), imgs, nil
}

func writeManagedParts(tx *sql.Tx, taskID string, parts []ManagedPart, in []ManagedPartInput) error {
	for i, part := range parts {
		if part.ImageSlot != "" {
			if err := writeManagedImage(tx, taskID, part.ImageSlot, in[i].Image); err != nil {
				return err
			}
		}
	}
	return nil
}

func managedHasImages(in []ManagedPart) bool {
	for _, part := range in {
		if part.ImageSlot != "" {
			return true
		}
	}
	return false
}

func ValidManagedImageSlot(slot string) bool {
	if slot == "initial" || ValidManagedRequestID(slot) {
		return true
	}
	if !strings.HasPrefix(slot, "~") || len(slot) < 4 || slot[len(slot)-2] != ':' ||
		slot[len(slot)-1] < '1' || slot[len(slot)-1] > '3' {
		return false
	}
	id := slot[1 : len(slot)-2]
	return id == "initial" || ValidManagedRequestID(id)
}

func (s *Store) initManaged() error {
	_, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS managed_tasks (task_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_images (task_id TEXT NOT NULL, slot TEXT NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(task_id, slot));
CREATE TABLE IF NOT EXISTS task_attachments (task_id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(task_id, position));`)
	return err
}

func writeManagedImage(tx *sql.Tx, taskID, slot string, img *ManagedImage) error {
	if img == nil {
		return nil
	}
	if (img.Mime != "image/png" && img.Mime != "image/jpeg") || len(img.Bytes) == 0 || len(img.Bytes) > MaxManagedImageBytes {
		return errors.New("invalid screenshot for storage")
	}
	_, err := tx.Exec(`INSERT INTO managed_images(task_id,slot,mime,bytes) VALUES(?,?,?,?)`, taskID, slot, img.Mime, img.Bytes)
	return err
}

func (s *Store) ManagedImage(taskID, slot string) (ManagedImage, error) {
	var img ManagedImage
	err := s.db.QueryRow(`SELECT mime,bytes FROM managed_images WHERE task_id=? AND slot=?`, taskID, slot).Scan(&img.Mime, &img.Bytes)
	return img, err
}

func managedRows(tx *sql.Tx, id string) (Task, *ManagedState, error) {
	var t Task
	var data string
	if err := tx.QueryRow(`SELECT data FROM tasks WHERE id=?`, id).Scan(&data); err != nil {
		return t, nil, err
	}
	if err := json.Unmarshal([]byte(data), &t); err != nil {
		return t, nil, err
	}
	err := tx.QueryRow(`SELECT data FROM managed_tasks WHERE task_id=?`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return t, nil, nil // pre-existing cards are not enrolled
	}
	if err != nil {
		return t, nil, err
	}
	var state ManagedState
	if err = json.Unmarshal([]byte(data), &state); err != nil {
		return t, nil, err
	}
	return t, &state, nil
}

func writeManagedState(tx *sql.Tx, id string, state *ManagedState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE managed_tasks SET data=? WHERE task_id=?`, string(data), id)
	return err
}

func (s *Store) ManagedSnapshot(id string) (Task, *ManagedState, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Task{}, nil, err
	}
	defer tx.Rollback()
	return managedRows(tx, id)
}

func (s *Store) beginManagedMutation() (*sql.Tx, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	// Reserve the SQLite writer before reading a task. This also serializes
	// independent Store handles sharing the same database file.
	if _, err = tx.Exec(`UPDATE managed_tasks SET data=data WHERE 0`); err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func (m *ManagedState) Available(t Task, runner, owner string) (start, followUp bool) {
	if m == nil || runner == "" || owner == "" || m.RunID != t.RunID || t.Decision != nil {
		return false, false
	}
	if len(m.Turns) == 0 {
		return validFreshTaskBrief(t, m.HasInitial || managedHasImages(m.InitialParts)) && len(t.Events) == 1 && t.Events[0].Kind == "local_created", false
	}
	if m.Runner != runner || len(m.Turns) >= managedTurnLimit {
		return false, false
	}
	for _, tr := range m.Turns {
		switch {
		case tr.State == "uncertain", tr.State == "pending", tr.State == "running" && tr.Owner != owner:
			return false, false
		}
	}
	return false, (t.Status == "working" || t.Status == "ready" || t.Status == "blocked") &&
		(m.ThreadID != "" || m.Turns[0].State == "running" && m.Turns[0].Owner == owner)
}

func addManagedEvent(t *Task, kind, message string) {
	stamp := now()
	t.UpdatedAt = stamp
	t.Events = append(t.Events, Event{ID: fmt.Sprintf("%s-e%d", t.ID, len(t.Events)+1), Origin: managedOrigin, Kind: kind, Message: message, RunID: t.RunID, CreatedAt: stamp})
}

func writeManagedTask(tx *sql.Tx, t *Task) error {
	data, err := marshalTask(t)
	if err != nil {
		return err
	}
	_, err = tx.Exec(`UPDATE tasks SET data=? WHERE id=?`, string(data), t.ID)
	return err
}

func ValidManagedRequestID(id string) bool { return followUpRequestID.MatchString(id) }

func (s *Store) QueueManaged(id, runner, owner string, in ManagedInput) (bool, error) {
	if in.Parts != nil && (in.Kind != "follow_up" || in.Image != nil || in.Message != "") {
		return false, ErrManagedParts
	}
	parts, text, imgs, err := makeManagedParts(in.ID, in.Parts)
	if err != nil {
		return false, err
	}
	if in.Parts != nil {
		in.Message = text
	}
	in.Message = strings.TrimSpace(in.Message)
	if !followUpRequestID.MatchString(in.ID) || in.ID == "initial" || in.RunID == "" || runner == "" || owner == "" ||
		!utf8.ValidString(in.Message) || utf8.RuneCountInString(in.Message) > 2000 ||
		(in.Kind != "start" && in.Kind != "follow_up") ||
		(in.Kind == "start" && (in.Message != "" || in.Image != nil)) ||
		(in.Kind == "follow_up" && in.Message == "" && in.Image == nil && imgs == 0) {
		return false, errors.New("invalid managed turn")
	}
	digest := ""
	if in.Image != nil {
		digest = managedImageDigest(in.Image)
	}
	tx, err := s.beginManagedMutation()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	t, m, err := managedRows(tx, id)
	if err != nil {
		return false, err
	}
	if m == nil || m.RunID != in.RunID || t.RunID != in.RunID {
		return false, fmt.Errorf("%w: 此事项未启用卡内 Codex 执行。", ErrConflict)
	}
	for _, tr := range m.Turns {
		if tr.ID == in.ID {
			if tr.Kind == in.Kind && tr.Message == in.Message && tr.ImageDigest == digest && slices.Equal(tr.Parts, parts) {
				return false, nil // replay exposes original receipt only
			}
			return false, fmt.Errorf("%w: 请求编号已被别的指示使用。", ErrConflict)
		}
	}

	start, followUp := m.Available(t, runner, owner)
	if in.Kind == "start" && !start || in.Kind == "follow_up" && !followUp {
		return false, fmt.Errorf("%w: 此轮暂不能执行；请刷新并检查当前进度、待处理指示或运行环境。", ErrConflict)
	}
	if in.Kind == "start" {
		m.Runner = runner
		t.Status = "working"
		t.CodexLaunchNotice, t.LocalVisibility = nil, nil
		t.Summary = "已要求启动 Codex，尚未验证交付。"
		addManagedEvent(&t, "managed:requested", t.Summary)
		if err = writeManagedTask(tx, &t); err != nil {
			return false, err
		}
	}
	if err = writeManagedImage(tx, id, in.ID, in.Image); err != nil {
		return false, err
	}
	if err = writeManagedParts(tx, id, parts, in.Parts); err != nil {
		return false, err
	}
	m.Turns = append(m.Turns, ManagedTurn{ID: in.ID, Kind: in.Kind, Message: in.Message, Owner: owner, State: "pending", ImageDigest: digest, Parts: parts})
	if err = writeManagedState(tx, id, m); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// Claim is durable before launch. A different process can never consume a
// pending or running request from an interrupted instance.
func (s *Store) ClaimManaged(id, runner, owner string) (Task, ManagedTurn, string, string, error) {
	tx, err := s.beginManagedMutation()
	if err != nil {
		return Task{}, ManagedTurn{}, "", "", err
	}
	defer tx.Rollback()
	t, m, err := managedRows(tx, id)
	if err != nil || m == nil || m.RunID != t.RunID || m.Runner != runner || t.Decision != nil {
		return t, ManagedTurn{}, "", "", err
	}
	for _, tr := range m.Turns {
		if tr.State == "running" || tr.State == "uncertain" {
			return t, ManagedTurn{}, "", "", nil
		}
	}
	for i, tr := range m.Turns {
		if tr.State != "pending" {
			continue
		}
		if tr.Owner != owner || tr.Kind == "follow_up" && !bindingUUID.MatchString(m.ThreadID) ||
			tr.Kind == "start" && (i != 0 || m.ThreadID != "" || t.Status != "working") {
			return t, ManagedTurn{}, "", "", nil
		}
		slot := ""
		if tr.Kind == "start" && m.HasInitial {
			slot = "initial"
		} else if tr.ImageDigest != "" {
			slot = tr.ID
		}
		tr.State = "running"
		m.Turns[i] = tr
		if err = writeManagedState(tx, id, m); err != nil {
			return t, ManagedTurn{}, "", "", err
		}
		if tr.Kind == "start" {
			tr.Parts = m.InitialParts
		}
		return t, tr, m.ThreadID, slot, tx.Commit()
	}
	return t, ManagedTurn{}, "", "", nil
}

// Finish publishes an initial result and its exact turn receipt atomically.
// Follow-ups do not rewrite the original result, evidence or viewed marker.
func (s *Store) FinishManaged(id, run, runner, owner, request, state, nativeID, summary, reply string, evidence []Evidence) error {
	if (state != "completed" && state != "blocked" && state != "uncertain") ||
		(state == "completed" && (!bindingUUID.MatchString(nativeID) || !usableEvidence(evidence))) {
		return errors.New("invalid managed result")
	}
	tx, err := s.beginManagedMutation()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, m, err := managedRows(tx, id)
	if err != nil {
		return err
	}
	if m == nil || m.RunID != run || t.RunID != run || m.Runner != runner {
		return ErrConflict
	}
	for i, tr := range m.Turns {
		if tr.ID != request || tr.Owner != owner || tr.State != "running" {
			continue
		}
		if tr.Kind == "start" {
			if m.ThreadID != "" || t.Status != "working" {
				return ErrConflict
			}
			switch state {
			case "completed":
				t.Status = "ready"
				addManagedEvent(&t, "reports:ready", summary)
			default:
				t.Status = "blocked"
				addManagedEvent(&t, "reports:failed", summary)
			}
			if state != "uncertain" && bindingUUID.MatchString(nativeID) {
				m.ThreadID = nativeID
			}
			t.Summary, t.Evidence, t.ObservedAt, t.LocalVisibility = summary, evidence, t.UpdatedAt, nil
			if err = writeManagedTask(tx, &t); err != nil {
				return err
			}
		} else if state != "uncertain" && nativeID != m.ThreadID {
			return ErrConflict
		}
		m.Turns[i].State, m.Turns[i].Reply = state, reply
		// An unverified previous turn must never silently consume a newer
		// request. Preserve the saved text/image and show it as not sent.
		if state != "completed" {
			for j := range m.Turns {
				if m.Turns[j].State == "pending" {
					m.Turns[j].State = "blocked"
					m.Turns[j].Reply = "上一轮未交付；本条指示未发送。"
				}
			}
		}
		if err = writeManagedState(tx, id, m); err != nil {
			return err
		}
		return tx.Commit()
	}
	return ErrConflict
}

// Prevent legacy reports or fresh Codex claims from competing with a managed
// execution. Invoke inside the transaction which already loaded the Task.
func hasManagedOwner(tx *sql.Tx, id, run string) (bool, error) {
	var data string
	err := tx.QueryRow(`SELECT data FROM managed_tasks WHERE task_id=?`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var m ManagedState
	if err = json.Unmarshal([]byte(data), &m); err != nil {
		return false, err
	}
	return m.RunID == run && len(m.Turns) > 0, nil
}
