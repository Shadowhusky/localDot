package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func newManager(t *testing.T) (*Manager, *world) {
	t.Helper()
	w := newWorld(t)
	dir := t.TempDir()
	settings, _ := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	budget, _ := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	deps := w.deps()
	deps.Budget, deps.Settings = budget, settings
	m := NewManager(ManagerDeps{Deps: deps, Ports: PortRange{}, CellsDir: filepath.Join(dir, "cells")})
	t.Cleanup(m.CloseAll)
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, realValue)
	w.secret(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, realValue)
	return m, w
}

// cellClient talks to an opened cell's listener with its token, trusting its CA and the upstreams'.
func cellClient(w *world, o Opened) *http.Client {
	block, _ := pem.Decode([]byte(o.CACertPEM))
	ca, _ := x509.ParseCertificate(block.Bytes)
	roots := w.roots()
	roots.AddCert(ca)
	proxy := &url.URL{Scheme: "http", User: url.UserPassword("cell", o.ProxyToken), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(o.Port))}
	return &http.Client{
		Transport: &http.Transport{Proxy: http.ProxyURL(proxy), TLSClientConfig: &tls.Config{RootCAs: roots}, DisableKeepAlives: true},
		Timeout:   10 * time.Second,
	}
}

func rawConnectWith(t *testing.T, o Opened, authority string) (net.Conn, *http.Response) {
	t.Helper()
	conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(o.Port)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	io.WriteString(conn, "CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+"\r\nProxy-Authorization: Basic "+basicAuth("cell", o.ProxyToken)+"\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	return conn, resp
}

func TestOpenHandsTheCellEverythingItHolds(t *testing.T) {
	m, w := newManager(t)
	o, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(o.ProxyToken) < 43 || o.Port == 0 || !surrogate.Valid(o.Surrogates["weather"]) {
		t.Fatalf("opened %+v", o)
	}
	block, _ := pem.Decode([]byte(o.CACertPEM))
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil || len(ca.PermittedDNSDomains) != 1 || ca.PermittedDNSDomains[0] != "api.example.test" {
		t.Fatalf("CA %v %v", ca, err)
	}
	onDisk, err := os.ReadFile(o.CAPath)
	if err != nil || string(onDisk) != o.CACertPEM || filepath.Base(o.CAPath) != "ca.pem" {
		t.Fatalf("CA file %s: %v", o.CAPath, err)
	}
	resp, err := cellClient(w, o).Get("http://keyd.ldot/health")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health through the new listener: %v %v", resp, err)
	}
	resp.Body.Close()
	w.waitLine(func(l audit.Line) bool { return l.Kind == audit.KindAdmin && l.Reason == "cell-open" && l.Cell == "c1" })
}

func TestOpenValidates(t *testing.T) {
	m, _ := newManager(t)
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop"}); err != nil {
		t.Fatal(err)
	}
	cases := map[string]OpenRequest{
		"bad id":         {CellID: "../c", Role: "desktop"},
		"unknown role":   {CellID: "c2", Role: "root"},
		"port outside":   {CellID: "c2", Role: "desktop", Port: 4790},
		"unknown secret": {CellID: "c2", Role: "desktop", Secrets: []string{"nope"}},
		"secret twice":   {CellID: "c2", Role: "desktop", Secrets: []string{"weather", "weather"}},
		"llm off brain":  {CellID: "c2", Role: "desktop", Secrets: []string{"anthropic"}},
		"http on brain":  {CellID: "c2", Role: "brain", Secrets: []string{"weather"}},
		"already open":   {CellID: "c1", Role: "desktop"},
	}
	for name, req := range cases {
		if _, err := m.Open(req); err == nil {
			t.Errorf("%s: Open succeeded", name)
		}
	}
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop"}); !errors.Is(err, ErrCellExists) {
		t.Fatalf("reopen: %v", err)
	}
}

// The daemon's purpose check reaches its judge through a judge cell: the web API key is swapped
// at its bound host, and nothing else on the web or the LLM gateway is reachable.
func TestAJudgeCellReachesOnlyItsKeysHosts(t *testing.T) {
	m, w := newManager(t)
	seen := make(chan string, 1)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, seen))
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "ok") }))
	if _, err := m.Open(OpenRequest{CellID: "j0", Role: "judge", Secrets: []string{"anthropic"}}); err == nil {
		t.Fatal("a judge cell took an LLM key")
	}
	o, err := m.Open(OpenRequest{CellID: "j1", Role: "judge", Secrets: []string{"weather"}})
	if err != nil {
		t.Fatal(err)
	}
	client := cellClient(w, o)
	resp, _ := do(t, client, "POST", "https://api.example.test/v1/systemone", http.Header{"Authorization": {"Bearer " + o.Surrogates["weather"]}})
	if got := <-seen; resp.StatusCode != 200 || got != "Bearer "+realValue {
		t.Fatalf("judge request: %d, upstream saw %q", resp.StatusCode, got)
	}
	if _, connected := rawConnectWith(t, o, "www.example.test:443"); connected.StatusCode == 200 {
		t.Fatal("a judge cell reached the web")
	}
	if resp, err := client.Post("http://llm.ldot/anthropic/messages", "application/json", strings.NewReader("{}")); err == nil && resp.StatusCode == 200 {
		t.Fatal("a judge cell reached the LLM gateway")
	}
}

func TestCloseRemovesTheListenerSurrogatesAndCA(t *testing.T) {
	m, w := newManager(t)
	o, _ := m.Open(OpenRequest{CellID: "c1", Role: "brain", Secrets: []string{"anthropic"}})
	m.BeginTask("c1", "t1", 0)
	if err := m.Close("c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := cellClient(w, o).Get("http://keyd.ldot/health"); err == nil {
		t.Fatal("the listener still answers")
	}
	if len(w.registry.ForCell("c1")) != 0 {
		t.Fatal("surrogates outlived the cell")
	}
	if _, err := os.Stat(filepath.Dir(o.CAPath)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("CA folder left behind: %v", err)
	}
	if _, ok := m.Cell("c1"); ok {
		t.Fatal("the cell is still listed")
	}
	if err := m.Close("c1"); !errors.Is(err, ErrUnknownCell) {
		t.Fatalf("second Close: %v", err)
	}
}

func TestRevokeIsTheKillSwitch(t *testing.T) {
	m, w := newManager(t)
	streaming := make(chan struct{})
	upstreamDone := make(chan struct{})
	w.plainUpstream("stream.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		io.WriteString(rw, "data: start\n\n")
		rw.(http.Flusher).Flush()
		close(streaming)
		<-r.Context().Done()
		close(upstreamDone)
	}))
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "ok") }))
	o, _ := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	m.BeginTask("c1", "t1", 0)
	client := cellClient(w, o)

	resp, err := client.Get("http://stream.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	<-streaming
	tunnel, connected := rawConnectWith(t, o, "www.example.test:443")
	if connected.StatusCode != 200 {
		t.Fatalf("tunnel: %d", connected.StatusCode)
	}

	n, err := m.Revoke("c1")
	if err != nil || n != 1 {
		t.Fatalf("Revoke = %d, %v", n, err)
	}
	ended := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(resp.Body)
		ended <- err
	}()
	select {
	case err := <-ended:
		if err == nil {
			t.Fatal("the stream survived the kill switch")
		}
	case <-time.After(time.Second):
		resp.Body.Close()
		t.Fatal("Stop waited for the client's ten-second timeout")
	}
	select {
	case <-upstreamDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream request survived the kill switch")
	}
	tunnel.SetReadDeadline(time.Now().Add(3 * time.Second))
	if n, err := tunnel.Read(make([]byte, 1)); n != 0 || err == nil {
		t.Fatalf("the tunnel survived the kill switch: %d %v", n, err)
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("the tunnel timed out rather than being closed by Stop")
	}
	req, _ := http.NewRequest("GET", "https://api.example.test/", nil)
	req.Header.Set("Authorization", "Bearer "+o.Surrogates["weather"])
	resp2, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != 403 || resp2.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
		t.Fatalf("old surrogate after the kill switch: %d %q", resp2.StatusCode, resp2.Header.Get("X-Keyd-Reason"))
	}
	if resp3, err := client.Get("http://keyd.ldot/health"); err != nil || resp3.StatusCode != 200 {
		t.Fatalf("the listener stopped: %v", err)
	}
	if info, _ := m.Cell("c1"); info.Task != nil {
		t.Fatalf("the task outlived the kill switch: %+v", info.Task)
	}
	fresh, err := m.Mint("c1", []string{"weather"})
	if err != nil || !surrogate.Valid(fresh["weather"]) || fresh["weather"] == o.Surrogates["weather"] {
		t.Fatalf("Mint after revoke: %v %v", fresh, err)
	}
	w.waitLine(func(l audit.Line) bool { return l.Reason == "cell-revoke" && strings.Contains(l.Detail, "1 surrogate") })
}

func TestMintStaysInsideTheCellCA(t *testing.T) {
	m, w := newManager(t)
	w.secret(vault.Record{ID: "maps", Kind: vault.KindHTTP, Hosts: []string{"maps.example.test"}, Header: "X-Api-Key", Format: "raw"}, realValue)
	m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	if _, err := m.Mint("c1", []string{"maps"}); err == nil {
		t.Fatal("minted a surrogate for a host the cell CA cannot vouch for")
	}
	if _, err := m.Mint("nope", []string{"weather"}); !errors.Is(err, ErrUnknownCell) {
		t.Fatalf("unknown cell: %v", err)
	}
}

func TestTasksAndListing(t *testing.T) {
	m, _ := newManager(t)
	m.Open(OpenRequest{CellID: "c1", Role: "brain", Secrets: []string{"anthropic"}})
	if err := m.BeginTask("nope", "t", 0); !errors.Is(err, ErrUnknownCell) {
		t.Fatalf("BeginTask on an unknown cell: %v", err)
	}
	if err := m.BeginTask("c1", "t1", 2.5); err != nil {
		t.Fatal(err)
	}
	info, ok := m.Cell("c1")
	if !ok || info.Role != "brain" || info.Task == nil || info.Task.ID != "t1" || info.Task.LimitUSD != 2.5 || len(info.Surrogates) != 1 || info.Surrogates[0].SecretID != "anthropic" {
		t.Fatalf("info %+v", info)
	}
	if strings.Contains(info.Surrogates[0].SurrogateID, "ld_") {
		t.Fatal("the listing exposes a surrogate")
	}
	m.EndTask("c1")
	if info, _ := m.Cell("c1"); info.Task != nil {
		t.Fatalf("task after EndTask: %+v", info.Task)
	}
	if len(m.Cells()) != 1 {
		t.Fatalf("Cells = %+v", m.Cells())
	}
}

// Legacy transport fixtures explicitly open their owned test generation; the
// production admin API requires an immutable priced ULID task owner.
func openFixtureAdmission(t *testing.T, m *Manager, id string) {
	t.Helper()
	gate := m.cells[id].cell.current().model
	snapshot := gate.Snapshot()
	if _, err := gate.Resume(snapshot.GenerationID, snapshot.Epoch); err != nil {
		t.Fatal(err)
	}
}

// Docker Engine's gates reach a cell through <RelayDir>/<port>.sock, with the same token check.
func TestARelayDirServesTheCellOnASocket(t *testing.T) {
	m, w := newManager(t)
	// macOS caps a socket path at 104 bytes, which a test's TempDir can exceed.
	relay, err := os.MkdirTemp("/tmp", "keyd-relay-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(relay) })
	m.d.RelayDir = relay
	port := freePort(t)
	m.d.Ports = PortRange{Min: port, Max: port}
	stale := RelaySocket(relay, port)
	if err := os.WriteFile(stale, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	o, err := m.Open(OpenRequest{CellID: "c1", Role: "brain", Port: port, Secrets: []string{"anthropic"}})
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(stale)
	if err != nil || info.Mode().Type() != os.ModeSocket || info.Mode().Perm() != 0o666 {
		t.Fatalf("socket %v, %v", info, err)
	}
	get := func(token string) (int, error) {
		proxy := &url.URL{Scheme: "http", User: url.UserPassword("cell", token), Host: "gate"}
		client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
			Proxy:             http.ProxyURL(proxy),
			DisableKeepAlives: true,
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{}).DialContext(ctx, "unix", stale)
			},
		}}
		resp, err := client.Get("http://keyd.ldot/health")
		if err != nil {
			return 0, err
		}
		resp.Body.Close()
		return resp.StatusCode, nil
	}
	if status, err := get(o.ProxyToken); err != nil || status != http.StatusOK {
		t.Fatalf("with the token: %d, %v", status, err)
	}
	if status, err := get("not-the-token-not-the-token-not-the-token"); err != nil || status != http.StatusProxyAuthRequired {
		t.Fatalf("without the token: %d, %v", status, err)
	}
	if _, err := cellClient(w, o).Get("http://keyd.ldot/health"); err != nil {
		t.Fatalf("the TCP listener stopped answering: %v", err)
	}
	if err := m.Close("c1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("socket left after Close: %v", err)
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}
