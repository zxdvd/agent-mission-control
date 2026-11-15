//go:build !linux && !darwin

package main

import (
	"errors"
	"os/exec"
)

func configureCodexProcess(_ *exec.Cmd) error {
	return errors.New("codex-run currently supports only Linux and macOS process cleanup")
}
