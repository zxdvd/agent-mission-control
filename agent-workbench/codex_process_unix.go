//go:build linux || darwin

package main

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// Keep native Codex and its ordinary subprocesses in their own group. Deadline
// cancellation cannot kill Workbench's process group or leave a tool holding
// stdout open. This is process cleanup, not a sandbox or policy replacement.
func configureCodexProcess(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	cmd.WaitDelay = 200 * time.Millisecond
	return nil
}
