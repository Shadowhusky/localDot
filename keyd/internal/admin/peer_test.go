package admin

import (
	"bufio"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// A test binary started with KEYD_PEER_LISTEN listens there until its input closes, standing in for
// another keyd run from this same executable.
func TestMain(m *testing.M) {
	if path := os.Getenv("KEYD_PEER_LISTEN"); path != "" {
		ln, err := net.Listen("unix", path)
		if err != nil {
			os.Exit(1)
		}
		go func() {
			for {
				conn, err := ln.Accept()
				if err != nil {
					return
				}
				go io.Copy(io.Discard, conn)
			}
		}()
		os.Stdout.WriteString("ready\n")
		io.Copy(io.Discard, os.Stdin)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestDaemonArgsAreFlagsOnly(t *testing.T) {
	for cmdline, want := range map[string]bool{
		"/bin/keyd\x00": true,
		"/bin/keyd\x00-home\x00/h\x00-vault\x00file\x00": true,
		"/bin/keyd\x00self-test\x00-home\x00/h\x00":      false,
		"/bin/keyd\x00keychain-item\x00read\x00":         false,
		"":                                               false,
		"\x00":                                           false,
		"\x00-x":                                         false,
	} {
		if daemonArgs([]byte(cmdline)) != want {
			t.Errorf("daemonArgs(%q) = %v", cmdline, !want)
		}
	}
}

// listener starts program as the process behind a socket and waits until it answers there.
func listener(t *testing.T, path string, cmd *exec.Cmd) {
	t.Helper()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Skipf("%s: %v", cmd.Path, err)
	}
	t.Cleanup(func() {
		stdin.Close()
		cmd.Process.Kill()
		cmd.Wait()
	})
	go bufio.NewReader(stdout).ReadString('\n')
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if conn, err := net.Dial("unix", path); err == nil {
			conn.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Skipf("%s did not listen on %s", cmd.Path, path)
}

func peerOf(t *testing.T, path string) error {
	t.Helper()
	conn, err := net.Dial("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	return GenuineKeydPeer(conn.(*net.UnixConn))
}

func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "kp")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

// This test binary is unsigned, so the check it makes is the development build's: the peer must
// run this same executable, in daemon mode.
func TestGenuineKeydPeerAcceptsThisExecutable(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(shortDir(t), "s")
	cmd := exec.Command(self, "-test.run=^$")
	cmd.Env = append(os.Environ(), "KEYD_PEER_LISTEN="+path)
	listener(t, path, cmd)
	if err := peerOf(t, path); err != nil {
		t.Fatalf("the same executable was refused: %v", err)
	}
}

func TestGenuineKeydPeerRefusesAnotherProgram(t *testing.T) {
	nc, err := exec.LookPath("nc")
	if err != nil {
		t.Skip("needs nc")
	}
	path := filepath.Join(shortDir(t), "s")
	listener(t, path, exec.Command(nc, "-lkU", path))
	if err := peerOf(t, path); err == nil {
		t.Fatal("another program passed as keyd")
	}
}

func TestGenuineKeydPeerRefusesAKeydSubcommand(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(shortDir(t), "s")
	cmd := exec.Command(self, "self-test")
	cmd.Env = append(os.Environ(), "KEYD_PEER_LISTEN="+path)
	listener(t, path, cmd)
	if err := peerOf(t, path); err == nil {
		t.Fatal("a keyd subcommand passed as the daemon")
	}
}
