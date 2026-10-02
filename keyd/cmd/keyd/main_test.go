package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// shortHome keeps the admin socket path under the 104-byte limit macOS puts on Unix sockets.
func shortHome(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "keyd-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func socketClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "unix", path)
	}}}
}

func adminCall(t *testing.T, c *http.Client, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, "http://keyd"+path, r)
	resp, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestStartServesTheAdminSocketAndCleansUp(t *testing.T) {
	home := shortHome(t)
	d, err := start(Config{Home: home, Vault: "memory", Ports: egress.PortRange{}})
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, "keyd")
	for path, want := range map[string]os.FileMode{dir: 0o700, d.Socket: 0o600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != want {
			t.Fatalf("%s: %v %v, want %v", path, info.Mode().Perm(), err, want)
		}
	}
	if _, err := start(Config{Home: home, Vault: "memory"}); err == nil || !strings.Contains(err.Error(), "already running") {
		t.Fatalf("a second keyd on the same home: %v", err)
	}

	admin := socketClient(d.Socket)
	code, status := adminCall(t, admin, "GET", "/v1/status", nil)
	if code != 200 || status["bootId"] != d.BootID {
		t.Fatalf("status: %d %v", code, status)
	}
	sealed, _ := vault.Seal(status["sealKey"].(string), vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, []byte("real-secret-value-for-test"))
	if code, body := adminCall(t, admin, "PUT", "/v1/secrets/anthropic", map[string]any{"kind": "llm", "provider": "anthropic", "sealed": sealed}); code != 200 {
		t.Fatalf("put: %d %v", code, body)
	}
	code, opened := adminCall(t, admin, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "brain", "secrets": []string{"anthropic"}})
	if code != 201 {
		t.Fatalf("open: %d %v", code, opened)
	}
	port := int(opened["port"].(float64))
	proxy := &url.URL{Scheme: "http", User: url.UserPassword("cell", opened["proxyToken"].(string)), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(port))}
	cell := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxy)}}
	resp, err := cell.Get("http://keyd.ldot/health")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health: %v %v", resp, err)
	}
	resp.Body.Close()

	d.Close()
	if _, err := os.Stat(d.Socket); !os.IsNotExist(err) {
		t.Fatalf("socket left behind: %v", err)
	}
	if _, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port))); err == nil {
		t.Fatal("the cell listener outlived keyd")
	}
	f, _ := os.Open(filepath.Join(dir, "audit.jsonl"))
	defer f.Close()
	n, err := audit.Verify(f)
	if err != nil || n < 4 {
		t.Fatalf("audit chain: %d lines, %v", n, err)
	}
	again, err := start(Config{Home: home, Vault: "memory"})
	if err != nil {
		t.Fatalf("restart after a clean stop: %v", err)
	}
	if again.BootID == d.BootID {
		t.Fatal("a restart kept the boot id")
	}
	again.Close()
}

func TestVerifyAuditCommand(t *testing.T) {
	home := shortHome(t)
	d, err := start(Config{Home: home, Vault: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	d.Close()
	path := filepath.Join(home, "keyd", "audit.jsonl")
	var out bytes.Buffer
	if code := run([]string{"verify-audit", path}, &out); code != 0 || !strings.Contains(out.String(), "audit ok") {
		t.Fatalf("verify: %d %s", code, out.String())
	}
	data, _ := os.ReadFile(path)
	os.WriteFile(path, bytes.Replace(data, []byte(`"reason":"start"`), []byte(`"reason":"stArt"`), 1), 0o600)
	out.Reset()
	if code := run([]string{"verify-audit", path}, &out); code != 1 {
		t.Fatalf("a tampered log verified: %d %s", code, out.String())
	}
}

func TestBadFlagsExitWithUsage(t *testing.T) {
	var out bytes.Buffer
	for _, args := range [][]string{{"-ports", "4789-4760"}, {"-vault", "plaintext"}, {"-nope"}} {
		out.Reset()
		if code := run(args, &out); code != 2 {
			t.Errorf("%v: exit %d, want 2", args, code)
		}
	}
}
