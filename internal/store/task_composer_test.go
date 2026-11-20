package store

import (
	"path/filepath"
	"testing"
)

func TestTaskComposerRollsBackAllRowsOnMidAttachmentFailure(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "workbench.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	_, err = s.db.Exec(`CREATE TRIGGER failed_attachment BEFORE INSERT ON task_attachments WHEN NEW.position = 2 BEGIN SELECT RAISE(ABORT, 'test abort'); END;`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.ComposeTask("Fixture only", "", nil, []TaskAttachment{{Name: "one", Bytes: []byte{1}}, {Name: "two", Bytes: []byte{2}}})
	if err == nil {
		t.Fatal("expected second attachment insert to fail")
	}
	for _, table := range []string{"tasks", "managed_tasks", "managed_images", "task_attachments"} {
		var count int
		if err := s.db.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("partial write in %s: %d %v", table, count, err)
		}
	}
}
