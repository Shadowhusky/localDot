package vault

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// tool runs a system program that keeps or wraps secrets. Values travel on stdin and stdout, never
// argv; the child gets only the variables in env; what it prints never reaches an error.
type tool struct {
	path    string
	env     []string
	timeout time.Duration
	// Package-local subprocess injection for offline fixtures.
	configureCommand func(*exec.Cmd)
}

// toolResult is how the program ended. started is false when it never ran, so nothing changed.
type toolResult struct {
	code     int
	started  bool
	timedOut bool
	stdout   []byte
	stderr   bool
}

func (t tool) run(ctx context.Context, stdin []byte, args ...string) toolResult {
	cmd := exec.CommandContext(ctx, t.path, args...)
	cmd.Env = t.env
	cmd.Dir = "/"
	if t.configureCommand != nil {
		t.configureCommand(cmd)
	}
	cmd.WaitDelay = 100 * time.Millisecond
	if stdin != nil {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	out := &boundedOutput{limit: 2*maxValueLen + 256}
	errOut := &boundedOutput{limit: 4096}
	cmd.Stdout, cmd.Stderr = out, errOut
	err := cmd.Run()
	result := toolResult{started: cmd.Process != nil, stdout: out.data.Bytes(), stderr: errOut.data.Len() > 0}
	var exit *exec.ExitError
	switch {
	case ctx.Err() != nil:
		result.timedOut, result.code = true, -1
	case err == nil:
	case errors.As(err, &exit):
		result.code = exit.ExitCode()
	default:
		result.code = -1
	}
	if out.overflow {
		result.code = -1
	}
	return result
}

func (t tool) deadline() (context.Context, context.CancelFunc) {
	limit := t.timeout
	if limit <= 0 {
		limit = 5 * time.Second
	}
	return context.WithTimeout(context.Background(), limit)
}

type boundedOutput struct {
	data     bytes.Buffer
	limit    int
	overflow bool
}

func (b *boundedOutput) Write(p []byte) (int, error) {
	if b.data.Len()+len(p) > b.limit {
		b.overflow = true
		return 0, io.ErrShortWrite
	}
	return b.data.Write(p)
}

// systemProgram finds name in the system's own directories only: a directory on the user's PATH
// could put another program in its place.
func systemProgram(name string) string {
	for _, dir := range []string{"/usr/bin", "/bin", "/usr/local/bin"} {
		path := filepath.Join(dir, name)
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() && info.Mode()&0o111 != 0 {
			return path
		}
	}
	return ""
}

// sessionEnv keeps only the variables a program needs to reach this user's session bus.
func sessionEnv(getenv func(string) string) []string {
	env := []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	if dir := getenv("XDG_RUNTIME_DIR"); filepath.IsAbs(dir) && printable(dir) {
		env = append(env, "XDG_RUNTIME_DIR="+dir)
	}
	if bus := getenv("DBUS_SESSION_BUS_ADDRESS"); bus != "" && printable(bus) {
		env = append(env, "DBUS_SESSION_BUS_ADDRESS="+bus)
	}
	return env
}

// hasSessionBus reports whether env names a session bus: an address, or the socket systemd puts
// in the runtime directory, which libdbus and GDBus find on their own.
func hasSessionBus(env []string) bool {
	for _, entry := range env {
		if strings.HasPrefix(entry, "DBUS_SESSION_BUS_ADDRESS=") {
			return true
		}
		if dir, ok := strings.CutPrefix(entry, "XDG_RUNTIME_DIR="); ok {
			if info, err := os.Stat(filepath.Join(dir, "bus")); err == nil && info.Mode()&os.ModeSocket != 0 {
				return true
			}
		}
	}
	return false
}

func printable(s string) bool {
	for _, c := range []byte(s) {
		if c < 0x20 || c > 0x7e {
			return false
		}
	}
	return true
}
