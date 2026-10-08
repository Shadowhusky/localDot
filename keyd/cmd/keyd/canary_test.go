package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/canaryrun"
)

func TestCanaryRunRequiresPrivatePipeTransport(t *testing.T) {
	file, err := os.OpenFile(filepath.Join(t.TempDir(), "output"), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if code := runCanaryWith(nil, file, file, file, nil, nil); code != 2 {
		t.Fatalf("regular output accepted: %d", code)
	}
	if code := runCanaryWith([]string{"--unknown"}, file, file, file, nil, nil); code != 2 {
		t.Fatalf("invalid flags accepted: %d", code)
	}
	info, err := file.Stat()
	if err != nil || info.Size() != 0 {
		t.Fatal("credential output written to file")
	}
}

func TestCanaryLockReceiptRetainsLease(t *testing.T) {
	directory, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(directory, 0700); err != nil {
		t.Fatal(err)
	}
	lease, err := os.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	other, err := os.Open(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer writer.Close()
	if err := reader.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	nonce := strings.Repeat("a", 64)
	if code := runCanaryLock([]string{directory, nonce}, lease, writer); code != 0 {
		t.Fatal(code)
	}
	data := make([]byte, 128)
	n, err := reader.Read(data)
	if err != nil || string(data[:n]) != "locked:"+nonce+"\n" {
		t.Fatal("missing exact receipt", err)
	}
	if code := runCanaryLock([]string{directory, nonce}, other, writer); code != 73 {
		t.Fatal("competing recovery acquired", code)
	}
	if code := runCanaryLock([]string{directory, "bad"}, lease, writer); code != 2 {
		t.Fatal("bad nonce", code)
	}
	lease.Close()
	if code := runCanaryLock([]string{directory, nonce}, other, writer); code != 0 {
		t.Fatal("recovery refused after release", code)
	}
}

func TestCanaryRunRefusesMissingDirectoryLeaseBeforeStarting(t *testing.T) {
	in, parent, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	defer parent.Close()
	reader, out, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	defer out.Close()
	code := runCanaryWith(nil, in, out, out, nil, func(context.Context, canaryrun.Config) (canarySession, error) {
		t.Fatal("gateway started without a lease")
		return nil, nil
	})
	if code != 73 {
		t.Fatal("missing lease accepted", code)
	}
}

type fakeCanarySession struct {
	ready    canaryrun.Ready
	closed   chan struct{}
	once     sync.Once
	closeErr error
}

func (s *fakeCanarySession) Ready() canaryrun.Ready { return s.ready }
func (s *fakeCanarySession) Close() (canaryrun.Closed, error) {
	s.once.Do(func() { close(s.closed) })
	return canaryrun.Closed{V: 1, Type: "closed", RunID: s.ready.RunID, CellID: s.ready.CellID, GatewayClosed: s.closeErr == nil}, s.closeErr
}
func TestCanaryRunPipeLifetime(t *testing.T) {
	for _, fault := range []string{"", "unexpected-input", "close-error", "broken-output", "broken-stderr", "start-error"} {
		t.Run("path-"+fault, func(t *testing.T) {
			directory, err := filepath.EvalSymlinks(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Chmod(directory, 0700); err != nil {
				t.Fatal(err)
			}
			lease, err := os.Open(directory)
			if err != nil {
				t.Fatal(err)
			}
			defer lease.Close()
			in, parent, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer in.Close()
			defer parent.Close()
			reader, out, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			defer out.Close()
			errorReader, errorWriter, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer errorReader.Close()
			defer errorWriter.Close()
			if errorReader.SetReadDeadline(time.Now().Add(3*time.Second)) != nil {
				t.Fatal("stderr deadline")
			}
			if reader.SetReadDeadline(time.Now().Add(3*time.Second)) != nil {
				t.Fatal("pipe deadline")
			}
			session := &fakeCanarySession{ready: canaryrun.Ready{V: 1, Type: "ready", RunID: "run-fixture", CellID: "cell-fixture", SyntheticSecret: "canary-synthetic-only"}, closed: make(chan struct{})}
			if fault == "close-error" {
				session.closeErr = errors.New("private failure")
			}
			if fault == "broken-output" {
				reader.Close()
			}
			if fault == "broken-stderr" {
				errorReader.Close()
			}
			completed := make(chan int, 1)
			go func() {
				completed <- runCanaryWith([]string{"--directory", directory, "--cell", "cell-fixture", "--run", "run-fixture"}, in, out, errorWriter, lease, func(_ context.Context, c canaryrun.Config) (canarySession, error) {
					if c.Directory != directory || c.CellID != "cell-fixture" || c.RunID != "run-fixture" {
						return nil, errors.New("wrong arguments")
					}
					if fault == "start-error" {
						return nil, errors.New("private start failure")
					}
					return session, nil
				})
			}()
			if fault != "broken-output" && fault != "broken-stderr" && fault != "start-error" {
				decoder := json.NewDecoder(reader)
				var ready canaryrun.Ready
				if err := decoder.Decode(&ready); err != nil || ready != session.ready {
					t.Fatal("missing ready receipt", err)
				}
				select {
				case <-session.closed:
					t.Fatal("retired before parent requested closure")
				default:
				}
				if fault == "unexpected-input" {
					if _, err := parent.Write([]byte("x")); err != nil {
						t.Fatal(err)
					}
				} else {
					parent.Close()
				}
				var closed canaryrun.Closed
				if err := decoder.Decode(&closed); err != nil || closed.Type != "closed" || closed.RunID != ready.RunID {
					t.Fatal("missing closed receipt", err)
				}
				if (fault == "close-error") == closed.GatewayClosed {
					t.Fatal("incorrect cleanup verdict")
				}
			}
			select {
			case code := <-completed:
				if (fault == "" && code != 0) || (fault != "" && code != 1) {
					t.Fatalf("unexpected exit %d", code)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("command did not retire")
			}
			errorWriter.Close()
			if fault != "broken-stderr" {
				markers, err := io.ReadAll(errorReader)
				if err != nil || strings.Contains(string(markers), session.ready.SyntheticSecret) {
					t.Fatal("unsafe stderr evidence", err)
				}
				expected := "canary:run-fixture:ready\ncanary:run-fixture:closed\n"
				if fault == "start-error" {
					expected = ""
				} else if fault == "broken-output" {
					expected = "canary:run-fixture:ready\n"
				}
				if string(markers) != expected {
					t.Fatal("missing stderr continuity controls")
				}
			}
			if fault != "start-error" {
				select {
				case <-session.closed:
				default:
					t.Fatal("session leaked")
				}
			}
		})
	}
}
