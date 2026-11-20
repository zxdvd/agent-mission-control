package store

import (
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

const MaxTaskAttachments = 3
const MaxTaskAttachmentBytes = 2 << 20

const WorkbenchCreateOrigin = "工作台新建"

var ErrEmptyTaskComposer = errors.New("请先输入任务内容或添加附件。")
var ErrLongTaskComposer = errors.New("任务内容最多 2000 字。")
var ErrTaskAttachments = errors.New("本地文件最多 3 个，每个不超过 2 MiB；文件名须有效且文件不能为空。")

type TaskAttachment struct {
	Name  string
	Bytes []byte
}

type TaskAttachmentInfo struct {
	Name string `json:"name"`
	Size int    `json:"size_bytes"`
}

// ComposeTask records a browser draft without running anything. Non-image files
// stay in a separate SQLite table and are never provided to an execution path.
func (s *Store) ComposeTask(goal, projectName string, image *ManagedImage, attachments []TaskAttachment) (Task, error) {
	return s.composeTask(goal, projectName, image, nil, attachments)
}

func (s *Store) ComposeTaskParts(projectName string, in []ManagedPartInput, attachments []TaskAttachment) (Task, error) {
	return s.composeTask("", projectName, nil, in, attachments)
}

func (s *Store) composeTask(goal, projectName string, image *ManagedImage, in []ManagedPartInput, attachments []TaskAttachment) (Task, error) {
	parts, plain, images, err := makeManagedParts("initial", in)
	if err != nil {
		return Task{}, err
	}
	if in != nil {
		goal = plain
	}
	hasImages := image != nil || images > 0
	goal = strings.TrimSpace(goal)
	if goal == "" && !hasImages && len(attachments) == 0 {
		return Task{}, ErrEmptyTaskComposer
	}
	if !utf8.ValidString(goal) || utf8.RuneCountInString(goal) > 2000 {
		return Task{}, ErrLongTaskComposer
	}
	if len(attachments) > MaxTaskAttachments {
		return Task{}, ErrTaskAttachments
	}
	for i := range attachments {
		file := &attachments[i]
		file.Name = strings.TrimSpace(file.Name)
		if file.Name == "" || file.Name == "." || file.Name == ".." || !utf8.ValidString(file.Name) ||
			utf8.RuneCountInString(file.Name) > 160 || strings.ContainsAny(file.Name, `/\`) ||
			strings.ContainsFunc(file.Name, func(r rune) bool { return unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) }) ||
			len(file.Bytes) == 0 || len(file.Bytes) > MaxTaskAttachmentBytes {
			return Task{}, ErrTaskAttachments
		}
	}
	return s.createLocal(CreateInput{ProjectName: projectName, Title: composerTitle(goal, hasImages), Goal: goal, Origin: WorkbenchCreateOrigin}, image, parts, in, attachments, true)
}

func composerTitle(goal string, hasImage bool) string {
	firstLine, _, _ := strings.Cut(goal, "\n")
	firstLine = strings.Join(strings.Fields(firstLine), " ")
	if firstLine == "" {
		if hasImage {
			return "图片任务"
		}
		return "附件任务"
	}
	const limit = 72
	if chars := []rune(firstLine); len(chars) > limit {
		return strings.TrimSpace(string(chars[:limit-1])) + "…"
	}
	return firstLine
}

func (s *Store) TaskAttachment(taskID string, position int) (TaskAttachment, error) {
	var file TaskAttachment
	err := s.db.QueryRow(`SELECT name, bytes FROM task_attachments WHERE task_id=? AND position=?`, taskID, position).Scan(&file.Name, &file.Bytes)
	return file, err
}
