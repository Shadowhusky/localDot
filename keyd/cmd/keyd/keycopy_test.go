package main

import (
	"bytes"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func TestKeychainServiceFlagNamesADotsOwnService(t *testing.T) {
	for _, service := range []string{"localdot-keyd.Work", "localdot-keyd.", "other", "localdot-keyd-test"} {
		var stderr bytes.Buffer
		if code := run([]string{"-home", shortHome(t), "-vault", "memory", "-keychain-service", service}, &stderr); code != 2 || !strings.Contains(stderr.String(), "-keychain-service") {
			t.Fatalf("%q: exit %d, %s", service, code, stderr.String())
		}
	}
}

// startDot runs this test binary as another dot's keyd, as its service would, and waits for its
// admin socket to answer.
func startDot(t *testing.T, home string, args ...string) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(self, append([]string{"-home", home, "-natpmp", "off", "-stun", "off", "-ports", "4798-4798"}, args...)...)
	cmd.Env = []string{"KEYD_TEST_RUN=1", "PATH=/usr/bin:/bin", "HOME=" + home}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cmd.Process.Signal(os.Interrupt)
		cmd.Wait()
	})
	socket := filepath.Join(home, "keyd", "admin.sock")
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if resp, err := socketClient(socket).Get("http://keyd/v1/status"); err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return socket
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the other dot's keyd did not start: %s", stderr.String())
	return ""
}

// A key copy reaches another dot's genuine keyd sealed to it, and nothing at all reaches a program
// of another kind listening where that keyd's socket would be.
func TestKeysCopyBetweenTwoDotsKeyds(t *testing.T) {
	source := shortHome(t)
	d, err := start(Config{Home: source, Vault: "memory", Ports: egress.PortRange{}})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	admin := socketClient(d.Socket)
	_, status := adminCall(t, admin, "GET", "/v1/status", nil)
	rec := vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}
	sealed, _ := vault.Seal(status["sealKey"].(string), rec, []byte("real-secret-value-for-test"))
	if code, body := adminCall(t, admin, "PUT", "/v1/secrets/anthropic", map[string]any{"kind": "llm", "provider": "anthropic", "sealed": sealed}); code != 200 {
		t.Fatalf("put: %d %v", code, body)
	}

	work := shortHome(t)
	workSocket := startDot(t, work, "-vault", "memory", "-keychain-service", "localdot-keyd.work")
	code, body := adminCall(t, admin, "POST", "/v1/keys/copy", map[string]any{"home": work})
	if code != 200 || body["secrets"] != 1.0 {
		t.Fatalf("copy: %d %v", code, body)
	}
	_, workStatus := adminCall(t, socketClient(workSocket), "GET", "/v1/status", nil)
	if workStatus["secrets"] != 1.0 || workStatus["keyCopy"] != true {
		t.Fatalf("the other dot's keyd: %v", workStatus)
	}

	locked := shortHome(t)
	startDot(t, locked, "-vault", "passphrase", "-keychain-service", "localdot-keyd.locked")
	if code, body := adminCall(t, admin, "POST", "/v1/keys/copy", map[string]any{"home": locked}); code != http.StatusConflict {
		t.Fatalf("a dot waiting for its passphrase: %d %v", code, body)
	}

	nc, err := exec.LookPath("nc")
	if err != nil {
		t.Skip("needs nc for a listener of another kind")
	}
	impostor := shortHome(t)
	if err := os.MkdirAll(filepath.Join(impostor, "keyd"), 0o700); err != nil {
		t.Fatal(err)
	}
	socket := filepath.Join(impostor, "keyd", "admin.sock")
	listener := exec.Command(nc, "-lU", socket)
	var received bytes.Buffer
	listener.Stdout = &received
	if err := listener.Start(); err != nil {
		t.Skipf("nc: %v", err)
	}
	t.Cleanup(func() {
		listener.Process.Kill()
		listener.Wait()
	})
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if _, err := os.Stat(socket); err == nil {
			break
		}
	}
	code, body = adminCall(t, admin, "POST", "/v1/keys/copy", map[string]any{"home": impostor})
	if code != http.StatusForbidden {
		t.Fatalf("a listener that is not keyd: %d %v", code, body)
	}
	listener.Process.Kill()
	listener.Wait()
	if received.Len() != 0 {
		t.Fatalf("a listener that is not keyd received %q", received.String())
	}
}
