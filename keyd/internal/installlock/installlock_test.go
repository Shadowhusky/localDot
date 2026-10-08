package installlock

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func private(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestExclusiveAndRelease(t *testing.T) {
	dir := private(t)
	first, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if other, err := Acquire(dir); !errors.Is(err, ErrBusy) {
		if other != nil {
			other.Close()
		}
		t.Fatalf("competing lock: %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	second, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "install.lock" {
		t.Fatalf("unexpected directory: %v %v", entries, err)
	}
}

func TestUnsafePaths(t *testing.T) {
	for _, kind := range []string{"symlink", "hardlink", "directory", "mode", "content", "parent-mode", "parent-link", "relative"} {
		t.Run(kind, func(t *testing.T) {
			dir := private(t)
			path := filepath.Join(dir, "install.lock")
			switch kind {
			case "symlink", "hardlink":
				target := filepath.Join(dir, "target")
				if err := os.WriteFile(target, nil, 0o600); err != nil {
					t.Fatal(err)
				}
				var err error
				if kind == "symlink" {
					err = os.Symlink(target, path)
				} else {
					err = os.Link(target, path)
				}
				if err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
			case "mode":
				if err := os.WriteFile(path, nil, 0o644); err != nil {
					t.Fatal(err)
				}
			case "content":
				if err := os.WriteFile(path, []byte("not our mutex"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "parent-mode":
				if err := os.Chmod(dir, 0o755); err != nil {
					t.Fatal(err)
				}
			case "parent-link":
				link := filepath.Join(private(t), "alias")
				if err := os.Symlink(dir, link); err != nil {
					t.Fatal(err)
				}
				dir = link
			case "relative":
				dir = "."
			}
			f, err := Acquire(dir)
			if f != nil {
				f.Close()
			}
			if !errors.Is(err, ErrUnsafe) {
				t.Fatalf("expected unsafe: %v", err)
			}
		})
	}
}

func TestHandshakeAndDescriptorOwnership(t *testing.T) {
	dir := private(t)
	nonce := strings.Repeat("a", 64)
	f, err := os.OpenFile(filepath.Join(dir, "install.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var output, stderr bytes.Buffer
	if code := Run([]string{dir, nonce}, f, &output, &stderr); code != 0 {
		t.Fatalf("exit %d: %s", code, &stderr)
	}
	if output.String() != "locked:"+nonce+"\n" {
		t.Fatal("wrong handshake")
	}
	if other, err := Acquire(dir); !errors.Is(err, ErrBusy) {
		if other != nil {
			other.Close()
		}
		t.Fatalf("not held: %v", err)
	}
	if code := Run([]string{dir, nonce}, nil, io.Discard, io.Discard); code != 1 {
		t.Fatal("accepted absent descriptor")
	}
	if code := Run([]string{dir, "bad"}, f, io.Discard, io.Discard); code != 2 {
		t.Fatal("accepted bad nonce")
	}
}

// This subprocess uses only this test executable, a private temp directory and stdin/stdout.
// Killing the holder verifies kernel release, not a synthetic PID/stale-file decision.
func TestProcessExitReleases(t *testing.T) {
	if os.Getenv("LOCALDOT_INSTALL_LOCK_TEST_CHILD") == "1" {
		f, err := Acquire(os.Getenv("LOCALDOT_INSTALL_LOCK_TEST_DIR"))
		if err != nil {
			os.Exit(1)
		}
		defer f.Close()
		io.WriteString(os.Stdout, "locked:"+strings.Repeat("a", 64)+"\n")
		var data [1]byte
		os.Stdin.Read(data[:])
		return
	}
	dir := private(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestProcessExitReleases$")
	cmd.Env = append(os.Environ(), "LOCALDOT_INSTALL_LOCK_TEST_CHILD=1", "LOCALDOT_INSTALL_LOCK_TEST_DIR="+dir)
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	ready := make(chan error, 1)
	go func() {
		got := make([]byte, 72)
		_, err := io.ReadFull(output, got)
		if err == nil && string(got) != "locked:"+strings.Repeat("a", 64)+"\n" {
			err = errors.New("bad handshake")
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("helper handshake timed out")
	}
	if f, err := Acquire(dir); !errors.Is(err, ErrBusy) {
		if f != nil {
			f.Close()
		}
		t.Fatalf("child not exclusive: %v", err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	cmd.Wait()
	f, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
}

func TestInheritedLockSurvivesHelperExit(t *testing.T) {
	if os.Getenv("LOCALDOT_INSTALL_LOCK_FD_CHILD") == "1" {
		os.Exit(Run([]string{os.Getenv("LOCALDOT_INSTALL_LOCK_TEST_DIR"), strings.Repeat("a", 64)}, os.NewFile(3, "inherited"), os.Stdout, os.Stderr))
	}
	dir := private(t)
	file, err := os.OpenFile(filepath.Join(dir, "install.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestInheritedLockSurvivesHelperExit$")
	cmd.Env = append(os.Environ(), "LOCALDOT_INSTALL_LOCK_FD_CHILD=1", "LOCALDOT_INSTALL_LOCK_TEST_DIR="+dir)
	cmd.ExtraFiles = []*os.File{file}
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "locked:"+strings.Repeat("a", 64)+"\n" {
		t.Fatal("bad handshake")
	}
	if other, err := Acquire(dir); !errors.Is(err, ErrBusy) {
		if other != nil {
			other.Close()
		}
		t.Fatalf("helper exit lost lock: %v", err)
	}
	file.Close()
	other, err := Acquire(dir)
	if err != nil {
		t.Fatal(err)
	}
	other.Close()
}
