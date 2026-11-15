// Package herdr provides read-only access to an already-running local Herdr.
// It does not start agents, connect remote machines, or infer task completion.
package herdr

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

var ErrUnavailable = errors.New("Herdr CLI is not installed on this host")

type Client struct {
	binary string
	run    func(context.Context, string, ...string) ([]byte, error)
}

// New uses the local PATH. No software is downloaded or installed.
func New() (*Client, error) {
	binary, err := exec.LookPath("herdr")
	if err != nil {
		return nil, ErrUnavailable
	}
	return &Client{binary: binary, run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return exec.CommandContext(ctx, name, args...).Output()
	}}, nil
}

// List returns the CLI's JSON verbatim. The installed schema must be checked
// before mapping it into workbench task states; agent status is only observation.
func (c *Client) List(ctx context.Context) (json.RawMessage, error) {
	return c.query(ctx, "agent", "list")
}

func (c *Client) Get(ctx context.Context, target string) (json.RawMessage, error) {
	if strings.TrimSpace(target) == "" || strings.HasPrefix(target, "-") || strings.ContainsAny(target, "\r\n\x00") {
		return nil, errors.New("a local pane ID or unique agent name is required")
	}
	return c.query(ctx, "agent", "get", target)
}

func (c *Client) query(ctx context.Context, args ...string) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	output, err := c.run(ctx, c.binary, args...)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("Herdr observation: %w", ctx.Err())
		}
		return nil, fmt.Errorf("Herdr observation failed: %w", err)
	}
	if !json.Valid(output) {
		return nil, errors.New("Herdr returned non-JSON output; check the installed CLI schema")
	}
	return json.RawMessage(output), nil
}
