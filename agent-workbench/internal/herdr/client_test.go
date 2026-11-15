package herdr

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestReadOnlyCommands(t *testing.T) {
	var got []string
	c := &Client{binary: "/local/herdr", run: func(_ context.Context, binary string, args ...string) ([]byte, error) {
		if binary != "/local/herdr" {
			t.Fatal(binary)
		}
		got = args
		return []byte(`{"observed":true}`), nil
	}}
	if _, err := c.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"agent", "list"}) {
		t.Fatal(got)
	}
	// Arguments are passed directly, not interpreted by a shell.
	target := "pane; echo not-a-command"
	if _, err := c.Get(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []string{"agent", "get", target}) {
		t.Fatal(got)
	}
	for _, invalid := range []string{"", " ", "--machine", "x\ny"} {
		if _, err := c.Get(context.Background(), invalid); err == nil {
			t.Fatalf("accepted %q", invalid)
		}
	}
}

func TestObservationFailures(t *testing.T) {
	c := &Client{run: func(context.Context, string, ...string) ([]byte, error) { return []byte("not JSON"), nil }}
	if _, err := c.List(context.Background()); err == nil {
		t.Fatal("accepted non-JSON")
	}
	c.run = func(ctx context.Context, _ string, _ ...string) ([]byte, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.List(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

func TestUnavailableIsExplicit(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if _, err := New(); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
}
