### Task 10: The cell listener — token, the self-test name and plain HTTP

Each cell gets its own explicit HTTP proxy on `127.0.0.1:<port>`. Any container with egress can
reach it through `host.docker.internal` (S4, Part 2's Task 9 re-review), so every request and every
CONNECT must carry the cell's token as Basic proxy credentials; refusals are 407, audited at most
once a second (P4a-R12, P4a-R13). This task serves plain `http://` requests and the cell's self-test
name `http://keyd.ldot/health` with `net/http`; CONNECT is Task 11's, and until then the listener
answers it 405. A plain request is inspected for surrogates before its host is checked, so one in
the host name is alerted like one anywhere else (a plain request never carries a surrogate: S4
caught iron-proxy swapping into cleartext). `forward` checks a request and swaps what it may carry
through `swap`, the one place real values go in, which refuses while the audit log cannot be written
(P4a-R17); `relay` sends it with `httputil.ReverseProxy` over the generation's transport — guarded
dials, verified TLS, no other proxy, no redirect followed — scrubbing the response and writing the
audit line when the body ends. `relay` asks for gzip itself and decodes a lone gzip itself; the
transport decodes nothing, because Go's transport removes one gzip layer and then every
`Content-Encoding` line, so a body gzipped twice would have reached the cell unscrubbed with no
coding named (review 2, M3). Any other coding, or a second one, on any line, is refused. `record`
makes the `key.use` event from the line as written, in which any surrogate-shaped text is already
its ID. An upstream failure answers 502 and keyd keeps serving; a failure mid-stream aborts the
cell's connection so the stream ends with an error; a cell that hangs up cancels the upstream
request. The generation (context, transport, tracked tunnels) is what `(*Cell).Revoke` replaces:
Task 15's kill switch is built on it.

**Files:**
- Create: `keyd/internal/egress/deps.go`, `keyd/internal/egress/generation.go`, `keyd/internal/egress/cell.go`,
  `keyd/internal/egress/internal.go`, `keyd/internal/egress/forward.go`
- Test: `keyd/internal/egress/harness_test.go`, `keyd/internal/egress/cell_test.go`

**Interfaces:**
- Consumes: Tasks 1–9: `keys.Registry` (`Inspect`, `ForCell`), `keys.ApplySwaps`, `keys.FromRecord`,
  `vault.Vault` (`Value`, `Records`, `Record`), `audit.Log` (`Write`, `Err`), `events.Hub`,
  `netguard.Dialer`, `netguard.DeniedError`, `netguard.ResolveError`, `scrub.New`,
  `policy.ParseHostPort`, `policy.Policy` (`PlainHTTP`), `surrogate.Mint` and `surrogate.ID` (tests).
- Produces: `Dialer` interface (`DialContext`); `Config{CellID string; Policy policy.Policy; Port int; Token string}`
  (Task 12 adds `CA`); `Deps{Registry, Vault, Audit, Events, Dialer, RootCAs}` (Task 14 adds the
  gateway's); `Open(Config, Deps) (*Cell, error)` (token ≥ 32 characters; `ErrPortInUse`);
  `(*Cell).ID()`, `Port()`, `Close()`, `Revoke()`, `ServeHTTP`; the `Reason…` constants in `cell.go`
  (`ReasonNoAudit` = `audit-unavailable` among them); the reserved name `keyd.ldot`; the
  `X-Keyd-Reason` header on every refusal keyd answers itself. Internal: `route{dest, target, line, gen}`,
  `(*Cell).forward`, `(*Cell).swap`, `(*Cell).relay`, `(*Cell).scrubberFor`, `generation` (`ctx`,
  `tr`, `track`, `stop`), `(*Cell).record` (audit line plus `key.use` event), `dialOutcome`, `coding`,
  `gunzip`, `msSince`. Test helpers for later tasks: the harness (`newWorld`, `world.tlsUpstream`,
  `world.plainUpstream`, `world.name`, `world.publish`, `world.cell`, `world.secret`, `world.mint`,
  `world.client`, `world.lines`, `world.waitLine`, `reasonIs`, `dialListener`, `rawConnect`,
  `basicAuth`), `get`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/egress/harness_test.go` — a fake internet: TLS upstreams (HTTP/2, like providers)
and plain ones on loopback, named through a fake resolver, with exact guard exceptions for their
ports and a dialer that maps `:443` and `:80` to them through the real guard:
```go
package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const testToken = "test-proxy-token-0123456789abcdefghijklmnopq"

// world is a fake internet: TLS and plain upstreams on loopback, reachable by name through a fake
// resolver, with exact guard exceptions for their ports and a dialer that maps :443 and :80 to them.
type world struct {
	t         *testing.T
	caKey     *ecdsa.PrivateKey
	caCert    *x509.Certificate
	mu        sync.Mutex
	names     map[string][]netip.Addr
	ports     map[string]string
	allow     []netip.AddrPort
	own       []netip.Prefix
	vault     *vault.Vault
	registry  *keys.Registry
	audit     *audit.Log
	auditPath string
	events    *events.Hub
}

func newWorld(t *testing.T) *world {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "upstream test CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	cert, _ := x509.ParseCertificate(der)
	dir := t.TempDir()
	v, err := vault.Open(vault.NewMemory(), filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	auditPath := filepath.Join(dir, "audit.jsonl")
	log, err := audit.Open(auditPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	return &world{
		t: t, caKey: key, caCert: cert,
		names: map[string][]netip.Addr{}, ports: map[string]string{},
		vault: v, registry: keys.NewRegistry(), audit: log, auditPath: auditPath, events: events.NewHub(),
	}
}

func (w *world) leaf(host string) tls.Certificate {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: host},
		DNSNames: []string{host}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, _ := x509.CreateCertificate(rand.Reader, tmpl, w.caCert, &key.PublicKey, w.caKey)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func (w *world) roots() *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(w.caCert)
	return p
}

// tlsUpstream serves host over TLS, with HTTP/2 as providers do, and a certificate from the
// upstream CA.
func (w *world) tlsUpstream(host string, h http.Handler) *httptest.Server {
	srv := httptest.NewUnstartedServer(h)
	srv.EnableHTTP2 = true
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{w.leaf(host)}}
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	w.t.Cleanup(srv.Close)
	w.publish(host, "443", srv.Listener.Addr().String(), true)
	return srv
}

func (w *world) plainUpstream(host string, h http.Handler) *httptest.Server {
	srv := httptest.NewServer(h)
	w.t.Cleanup(srv.Close)
	w.publish(host, "80", srv.Listener.Addr().String(), true)
	return srv
}

// name points host at addrs with no guard exception, for names that must be refused.
func (w *world) name(host string, addrs ...string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, a := range addrs {
		w.names[host] = append(w.names[host], netip.MustParseAddr(a))
	}
}

func (w *world) publish(host, port, addr string, except bool) {
	ap := netip.MustParseAddrPort(addr)
	w.mu.Lock()
	defer w.mu.Unlock()
	w.names[host] = []netip.Addr{ap.Addr()}
	w.ports[net.JoinHostPort(host, port)] = net.JoinHostPort(host, strconv.Itoa(int(ap.Port())))
	if except {
		w.allow = append(w.allow, ap)
	}
}

func (w *world) LookupNetIP(_ context.Context, _ string, host string) ([]netip.Addr, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if a, ok := w.names[host]; ok {
		return a, nil
	}
	return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
}

// portMap sends name:443 and name:80 to the port the fake upstream listens on, through the real guard.
type portMap struct{ w *world }

func (p portMap) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	p.w.mu.Lock()
	if mapped, ok := p.w.ports[address]; ok {
		address = mapped
	}
	allow := append([]netip.AddrPort(nil), p.w.allow...)
	own := append([]netip.Prefix(nil), p.w.own...)
	p.w.mu.Unlock()
	d := &netguard.Dialer{Guard: netguard.New(func() ([]netip.Prefix, error) { return own, nil }, allow...), Resolver: p.w}
	return d.DialContext(ctx, network, address)
}

func (w *world) deps() Deps {
	return Deps{Registry: w.registry, Vault: w.vault, Audit: w.audit, Events: w.events, Dialer: portMap{w}, RootCAs: w.roots()}
}

func (w *world) cell(id string, role policy.Role) *Cell {
	w.t.Helper()
	p, err := policy.ForRole(role)
	if err != nil {
		w.t.Fatal(err)
	}
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken}, w.deps())
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { c.Close() })
	return c
}

func (w *world) secret(rec vault.Record, value string) {
	w.t.Helper()
	if err := w.vault.Put(rec, []byte(value)); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) mint(cell, secretID string) string {
	w.t.Helper()
	rec, _ := w.vault.Record(secretID)
	b, err := keys.FromRecord(rec)
	if err != nil {
		w.t.Fatal(err)
	}
	e, err := w.registry.Mint(cell, b)
	if err != nil {
		w.t.Fatal(err)
	}
	return e.Token
}

func proxyURL(c *Cell, token string) *url.URL {
	return &url.URL{Scheme: "http", User: url.UserPassword("cell", token), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port()))}
}

// client goes through the cell's listener and trusts the upstream CA plus extra roots.
func (w *world) client(c *Cell, extra ...*x509.Certificate) *http.Client {
	roots := w.roots()
	for _, cert := range extra {
		roots.AddCert(cert)
	}
	return &http.Client{
		Transport:     &http.Transport{Proxy: http.ProxyURL(proxyURL(c, testToken)), TLSClientConfig: &tls.Config{RootCAs: roots}, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       10 * time.Second,
	}
}

func (w *world) lines() []audit.Line {
	w.t.Helper()
	data, err := os.ReadFile(w.auditPath)
	if err != nil {
		w.t.Fatal(err)
	}
	var out []audit.Line
	for _, raw := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		if len(raw) == 0 {
			continue
		}
		var l audit.Line
		if err := json.Unmarshal(raw, &l); err != nil {
			w.t.Fatal(err)
		}
		out = append(out, l)
	}
	return out
}

// waitLine waits for an audit line that satisfies match; decisions on streams are written when they end.
func (w *world) waitLine(match func(audit.Line) bool) audit.Line {
	w.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, l := range w.lines() {
			if match(l) {
				return l
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	w.t.Fatalf("no audit line matched; have %+v", w.lines())
	return audit.Line{}
}

func reasonIs(reason string) func(audit.Line) bool {
	return func(l audit.Line) bool { return l.Reason == reason }
}

func dialListener(c *Cell) (net.Conn, error) {
	return net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port())))
}

// rawConnect opens a CONNECT tunnel by hand and returns the connection after the reply.
func rawConnect(t *testing.T, c *Cell, authority string) (net.Conn, *http.Response) {
	t.Helper()
	conn, err := dialListener(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	req := "CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\nProxy-Authorization: Basic " +
		basicAuth("cell", testToken) + "\r\n\r\n"
	if _, err := conn.Write([]byte(req)); err != nil {
		t.Fatal(err)
	}
	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode == http.StatusOK && br.Buffered() > 0 {
		t.Fatal("bytes after the CONNECT reply")
	}
	return conn, resp
}

func basicAuth(user, pass string) string {
	return base64.StdEncoding.EncodeToString([]byte(user + ":" + pass))
}
```

`keyd/internal/egress/cell_test.go`:
```go
package egress

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func get(t *testing.T, client *http.Client, rawURL string) (*http.Response, string) {
	t.Helper()
	resp, err := client.Get(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func withToken(c *Cell, token string) *http.Client {
	tr := &http.Transport{DisableKeepAlives: true}
	if token != "" {
		tr.Proxy = http.ProxyURL(proxyURL(c, token))
	} else {
		tr.Proxy = http.ProxyURL(&url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port()))})
	}
	return &http.Client{Transport: tr, Timeout: 5 * time.Second}
}

func TestRequestsWithoutTheTokenAreRefused(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	// Refusals are audited at most once a second, so the one this test looks for goes first.
	for _, tc := range []struct{ token, reason string }{
		{"", ReasonAuthMissing},
		{"wrong-token-0123456789abcdefghijklmnopqrs", ReasonAuthInvalid},
		{testToken[:len(testToken)-1], ReasonAuthInvalid},
	} {
		resp, _ := get(t, withToken(c, tc.token), "http://keyd.ldot/health")
		if resp.StatusCode != http.StatusProxyAuthRequired || !strings.HasPrefix(resp.Header.Get("Proxy-Authenticate"), "Basic") || resp.Header.Get("X-Keyd-Reason") != tc.reason {
			t.Errorf("token %q: %d %v", tc.token, resp.StatusCode, resp.Header)
		}
	}
	conn, err := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port())))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
	line, _ := io.ReadAll(io.LimitReader(conn, 12))
	if string(line) != "HTTP/1.1 407" {
		t.Fatalf("CONNECT without a token: %q", line)
	}
	l := w.waitLine(reasonIs(ReasonAuthMissing))
	if l.Decision != audit.Deny || l.Cell != "c1" || l.Port != c.Port() || l.Status != http.StatusProxyAuthRequired {
		t.Fatalf("audit %+v", l)
	}
}

func TestAuthFailuresAreAuditedAtMostOncePerSecond(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	for range 20 {
		get(t, withToken(c, ""), "http://keyd.ldot/health")
	}
	n := 0
	for _, l := range w.lines() {
		if l.Reason == ReasonAuthMissing {
			n++
		}
	}
	// One a second: 20 quick refusals span at most a second boundary or two on a slow machine.
	if n < 1 || n > 3 {
		t.Fatalf("%d audit lines for 20 refused requests, want 1 to 3", n)
	}
}

func TestHealthNamesTheCell(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c-health", policy.Brain)
	resp, body := get(t, w.client(c), "http://keyd.ldot/health")
	var got struct {
		OK   bool   `json:"ok"`
		Cell string `json:"cell"`
	}
	json.Unmarshal([]byte(body), &got)
	if resp.StatusCode != 200 || !got.OK || got.Cell != "c-health" {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	if resp, _ := get(t, w.client(c), "http://keyd.ldot/other"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown internal path: %d", resp.StatusCode)
	}
}

func TestPlainHTTPReachesTheWebWithoutProxyHeaders(t *testing.T) {
	w := newWorld(t)
	seen := make(chan *http.Request, 1)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		io.WriteString(rw, "plain-ok")
	}))
	c := w.cell("c1", policy.Desktop)
	resp, body := get(t, w.client(c), "http://ports.example.test/dists/x?arch=arm64")
	if resp.StatusCode != 200 || body != "plain-ok" {
		t.Fatalf("%d %q", resp.StatusCode, body)
	}
	r := <-seen
	if r.Host != "ports.example.test" || r.URL.RequestURI() != "/dists/x?arch=arm64" || r.Header.Get("Proxy-Authorization") != "" {
		t.Fatalf("upstream saw host %q uri %q headers %v", r.Host, r.URL.RequestURI(), r.Header)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "http" && l.Decision == audit.Allow })
	if l.Host != "ports.example.test" || l.Path != "/dists/x" || l.Status != 200 || l.BytesOut != 8 {
		t.Fatalf("audit %+v", l)
	}
}

func TestPlainHTTPPolicy(t *testing.T) {
	w := newWorld(t)
	w.name("rebind.example.test", "127.0.0.1")
	desktop := w.cell("c1", policy.Desktop)
	brain := w.cell("c2", policy.Brain)
	cases := []struct {
		name   string
		cell   *Cell
		url    string
		status int
		reason string
	}{
		{"brain has no web", brain, "http://example.test/", 403, policy.ReasonNoWeb},
		{"deny list", desktop, "http://printer.local/", 403, policy.ReasonHostDenied},
		{"port 80 only", desktop, "http://example.test:8080/", 403, policy.ReasonPort},
		{"ip literal", desktop, "http://127.0.0.1:1234/v1/models", 403, policy.ReasonIPLiteral},
		{"mapped ip literal", desktop, "http://[::ffff:127.0.0.1]/", 403, policy.ReasonIPLiteral},
		{"single-label name", desktop, "http://localhost:1234/v1/models", 403, policy.ReasonHostInvalid},
		{"name resolving to loopback", desktop, "http://rebind.example.test/", 403, ReasonAddress},
		{"unresolvable", desktop, "http://nowhere.example.test/", 502, ReasonResolve},
	}
	for _, c := range cases {
		resp, _ := get(t, w.client(c.cell), c.url)
		if resp.StatusCode != c.status || resp.Header.Get("X-Keyd-Reason") != c.reason {
			t.Errorf("%s: %d %q, want %d %q", c.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), c.status, c.reason)
		}
	}
}

func TestTraceAndNonProxyRequestsAreRefused(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("echo.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	c := w.cell("c1", policy.Desktop)
	req, _ := http.NewRequest("TRACE", "http://echo.example.test/", nil)
	resp, err := w.client(c).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("TRACE: %d", resp.StatusCode)
	}
	conn, _ := net.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(c.Port())))
	defer conn.Close()
	io.WriteString(conn, "GET /path HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic "+basicAuth("cell", testToken)+"\r\n\r\n")
	line, _ := io.ReadAll(io.LimitReader(conn, 12))
	if string(line) != "HTTP/1.1 400" {
		t.Fatalf("origin-form request: %q", line)
	}
}

func TestSurrogatesNeverTravelOverPlainHTTP(t *testing.T) {
	w := newWorld(t)
	var reached atomic.Bool
	w.plainUpstream("api.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, "real-secret-value-for-test")
	c := w.cell("c1", policy.Desktop)
	tok := w.mint("c1", "weather")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	req, _ := http.NewRequest("GET", "http://api.example.test/v1", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := w.client(c).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "misplaced-surrogate" || reached.Load() {
		t.Fatalf("%d %q reached=%v", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), reached.Load())
	}
	select {
	case e := <-sub:
		ku := e.Data.(events.KeyUse)
		if e.Type != events.TypeKeyUse || ku.SecretID != "weather" || ku.Decision != "deny" || ku.Host != "api.example.test" {
			t.Fatalf("event %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no key.use alert")
	}
}

func TestAnUnknownSurrogateIsBlockedAndAlerted(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("upstream reached") }))
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	resp, _ := get(t, w.client(c), "http://ports.example.test/?k=ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA")
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	e := <-sub
	if ku := e.Data.(events.KeyUse); ku.SecretID != "unknown" || ku.Decision != "deny" {
		t.Fatalf("event %+v", e)
	}
}

func TestSurrogateTextNeverReachesTheAuditOrTheEvents(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("upstream reached") }))
	c := w.cell("c1", policy.Desktop)
	tok, _ := surrogate.Mint("key")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	for _, u := range []string{"http://ports.example.test/keys/" + tok, "http://" + tok + ".example.test/"} {
		resp, _ := get(t, w.client(c), u)
		if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
			t.Errorf("%s: %d %q", u, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
		select {
		case e := <-sub:
			if ku := e.Data.(events.KeyUse); strings.Contains(ku.Host+ku.Path, tok) {
				t.Errorf("key.use carries the surrogate: %+v", ku)
			}
		case <-time.After(time.Second):
			t.Errorf("%s: no key.use alert", u)
		}
	}
	logged, _ := os.ReadFile(w.auditPath)
	if strings.Contains(string(logged), tok) || !strings.Contains(string(logged), "surrogate:"+surrogate.ID(tok)) {
		t.Fatalf("audit: %s", logged)
	}
}

func TestUpstreamFailuresAnswer502AndKeydKeepsServing(t *testing.T) {
	w := newWorld(t)
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	w.publish("down.example.test", "80", addr, true)
	w.plainUpstream("up.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "up") }))
	c := w.cell("c1", policy.Desktop)
	if resp, _ := get(t, w.client(c), "http://down.example.test/"); resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonUpstream {
		t.Fatalf("down upstream: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if resp, body := get(t, w.client(c), "http://up.example.test/"); resp.StatusCode != 200 || body != "up" {
		t.Fatalf("after a failure: %d %q", resp.StatusCode, body)
	}
}

func TestAMidStreamUpstreamErrorEndsTheClientStream(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("stream.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: one\n\n")
		rw.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}))
	c := w.cell("c1", policy.Desktop)
	resp, err := w.client(c).Get("http://stream.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err == nil || !strings.Contains(string(body), "data: one") {
		t.Fatalf("body %q err %v, want the first event and then an error", body, err)
	}
	w.waitLine(reasonIs(ReasonAborted))
}

func TestAClientDisconnectAbortsTheUpstreamRequest(t *testing.T) {
	w := newWorld(t)
	aborted := make(chan struct{})
	w.plainUpstream("slow.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: start\n\n")
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
		close(aborted)
	}))
	c := w.cell("c1", policy.Desktop)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "GET", "http://slow.example.test/", nil)
	resp, err := w.client(c).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	resp.Body.Read(buf)
	cancel()
	resp.Body.Close()
	select {
	case <-aborted:
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream request kept running after the client left")
	}
	w.waitLine(reasonIs(ReasonClientGone))
}

func TestAnUnrequestedEncodingIsRefused(t *testing.T) {
	w := newWorld(t)
	gz := func(b []byte) []byte {
		var out bytes.Buffer
		zw := gzip.NewWriter(&out)
		zw.Write(b)
		zw.Close()
		return out.Bytes()
	}
	zipped := gz([]byte("hidden from the scrubber"))
	twice := gz(zipped)
	codings := map[string]struct {
		values []string
		body   []byte
	}{
		"br":       {[]string{"br"}, zipped},
		"stacked":  {[]string{"identity", "gzip"}, zipped},
		"listed":   {[]string{"identity, gzip"}, zipped},
		"gzip-gz":  {[]string{"gzip", "gzip"}, twice},
		"gzip-br":  {[]string{"gzip", "br"}, twice},
		"gzip-two": {[]string{"gzip, gzip"}, twice},
		"lone":     {[]string{"gzip"}, zipped},
	}
	for name, coded := range codings {
		w.plainUpstream(name+".example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
			rw.Header()["Content-Encoding"] = coded.values
			rw.Write(coded.body)
		}))
	}
	c := w.cell("c1", policy.Desktop)
	for name := range codings {
		resp, body := get(t, w.client(c), "http://"+name+".example.test/")
		if name == "lone" {
			if resp.StatusCode != 200 || body != "hidden from the scrubber" || resp.Header.Get("Content-Encoding") != "" {
				t.Errorf("a lone gzip, which keyd decodes: %d %q %q", resp.StatusCode, body, resp.Header.Get("Content-Encoding"))
			}
			continue
		}
		if resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonEncoding {
			t.Errorf("%s: %d %q", name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
	}
}

func TestRedirectsAreReturnedAndEachHopIsCheckedAgain(t *testing.T) {
	w := newWorld(t)
	w.name("internal-hop.example.test", "10.0.0.5")
	w.plainUpstream("redirect.example.test", http.RedirectHandler("http://internal-hop.example.test/admin", http.StatusFound))
	c := w.cell("c1", policy.Desktop)
	resp, _ := get(t, w.client(c), "http://redirect.example.test/")
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "http://internal-hop.example.test/admin" {
		t.Fatalf("redirect: %d %q", resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp, _ := get(t, w.client(c), resp.Header.Get("Location")); resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonAddress {
		t.Fatalf("second hop: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestRevokeEndsUpstreamRequestsAndKeepsTheListener(t *testing.T) {
	w := newWorld(t)
	upstreamDone := make(chan struct{})
	w.plainUpstream("stream.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		io.WriteString(rw, "data: start\n\n")
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
		close(upstreamDone)
	}))
	c := w.cell("c1", policy.Desktop)
	resp, err := w.client(c).Get("http://stream.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Read(make([]byte, 16))
	c.Revoke()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("the stream survived Revoke")
	}
	select {
	case <-upstreamDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream request survived Revoke")
	}
	if resp, _ := get(t, w.client(c), "http://keyd.ldot/health"); resp.StatusCode != 200 {
		t.Fatalf("the listener stopped: %d", resp.StatusCode)
	}
}

func TestOpenRefusesAShortTokenAndABusyPort(t *testing.T) {
	w := newWorld(t)
	p, _ := policy.ForRole(policy.Desktop)
	if _, err := Open(Config{CellID: "c1", Policy: p, Token: "short"}, w.deps()); err == nil {
		t.Fatal("a short token was accepted")
	}
	c := w.cell("c1", policy.Desktop)
	if _, err := Open(Config{CellID: "c2", Policy: p, Token: testToken, Port: c.Port()}, w.deps()); err == nil || !errors.Is(err, ErrPortInUse) {
		t.Fatalf("busy port: %v", err)
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/egress/`
Expected: FAIL — `[build failed]`, starting `internal/egress/cell_test.go:38:19: undefined: Cell`.

- [ ] **Step 3: Implement the listener**

`keyd/internal/egress/deps.go`:
```go
package egress

import (
	"context"
	"crypto/x509"
	"net"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Dialer is satisfied by *netguard.Dialer.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

type Config struct {
	CellID string
	Policy policy.Policy
	// Port 0 picks a free port; tests use it.
	Port  int
	Token string
}

type Deps struct {
	Registry *keys.Registry
	Vault    *vault.Vault
	Audit    *audit.Log
	Events   *events.Hub
	Dialer   Dialer
	// RootCAs verifies upstream TLS; nil means the system roots.
	RootCAs *x509.CertPool
}
```

`keyd/internal/egress/generation.go`:
```go
package egress

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"sync"
	"time"
)

// generation is what the kill switch replaces: the context every upstream request and tunnel
// hangs off, the transport whose pooled connections it closes, and the tunnels it tracks.
type generation struct {
	ctx    context.Context
	cancel context.CancelFunc
	tr     *http.Transport
	mu     sync.Mutex
	conns  map[net.Conn]struct{}
}

func newGeneration(d Deps) *generation {
	ctx, cancel := context.WithCancel(context.Background())
	tr := &http.Transport{
		DialContext:           d.Dialer.DialContext,
		TLSClientConfig:       &tls.Config{RootCAs: d.RootCAs, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   8,
		ExpectContinueTimeout: time.Second,
		// relay asks for gzip itself and decodes it, so it sees every coding a body has.
		DisableCompression: true,
	}
	return &generation{ctx: ctx, cancel: cancel, tr: tr, conns: map[net.Conn]struct{}{}}
}

// track registers a connection for the kill switch; one opened after the switch is closed at once.
func (g *generation) track(conn net.Conn) func() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ctx.Err() != nil {
		conn.Close()
		return func() {}
	}
	g.conns[conn] = struct{}{}
	return func() {
		g.mu.Lock()
		delete(g.conns, conn)
		g.mu.Unlock()
	}
}

func (g *generation) stop() {
	g.cancel()
	g.mu.Lock()
	for conn := range g.conns {
		conn.Close()
	}
	g.conns = map[net.Conn]struct{}{}
	g.mu.Unlock()
	g.tr.CloseIdleConnections()
}
```

`keyd/internal/egress/cell.go`:
```go
// Package egress is a cell's door to the outside: one explicit HTTP proxy per cell on 127.0.0.1,
// guarded by the cell's proxy token. It refuses what policy refuses, terminates TLS only for the
// hosts the cell's surrogates are bound to, swaps surrogates there and scrubs what comes back,
// and passes every other allowed host through after checking its SNI.
package egress

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
)

const (
	ReasonAuthMissing  = "proxy-auth-missing"
	ReasonAuthInvalid  = "proxy-auth-invalid"
	ReasonBadRequest   = "bad-request"
	ReasonMethod       = "method-not-allowed"
	ReasonNotFound     = "not-found"
	ReasonHandshake    = "tls-handshake-failed"
	ReasonHostMismatch = "host-mismatch"
	ReasonUpgrade      = "upgrade-refused"
	ReasonAddress      = "address-denied"
	ReasonResolve      = "resolve-failed"
	ReasonUpstream     = "upstream-error"
	ReasonUpstreamTLS  = "upstream-tls"
	ReasonAborted      = "upstream-aborted"
	ReasonClientGone   = "client-aborted"
	ReasonRevoked      = "revoked"
	ReasonEncoding     = "undecodable-encoding"
	ReasonSecret       = "secret-unavailable"
	ReasonNoAudit      = "audit-unavailable"
)

const (
	internalHost = "keyd.ldot"
	minTokenLen  = 32
)

var ErrPortInUse = errors.New("egress: listener port in use")

type Cell struct {
	cfg         Config
	deps        Deps
	ln          net.Listener
	srv         *http.Server
	intercepted map[string]bool
	authLog     rateLog
	mu          sync.Mutex
	gen         *generation
	closed      bool
}

func Open(cfg Config, deps Deps) (*Cell, error) {
	if len(cfg.Token) < minTokenLen {
		return nil, fmt.Errorf("egress: proxy token must be at least %d characters", minTokenLen)
	}
	ln, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if errors.Is(err, syscall.EADDRINUSE) {
		return nil, fmt.Errorf("%w: %d", ErrPortInUse, cfg.Port)
	}
	if err != nil {
		return nil, err
	}
	c := &Cell{cfg: cfg, deps: deps, ln: ln, gen: newGeneration(deps), intercepted: map[string]bool{}}
	c.srv = &http.Server{
		Handler:           c,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          log.New(io.Discard, "", 0),
	}
	go c.srv.Serve(ln)
	return c, nil
}

func (c *Cell) ID() string { return c.cfg.CellID }

func (c *Cell) Port() int { return c.ln.Addr().(*net.TCPAddr).Port }

// Close stops the listener and closes every connection the cell has, upstream ones included.
func (c *Cell) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	g := c.gen
	c.mu.Unlock()
	err := c.srv.Close()
	g.stop()
	return err
}

// Revoke is the kill switch for one cell: every upstream connection and tunnel closes, in-flight
// requests fail, and the cell starts a fresh generation.
func (c *Cell) Revoke() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	old := c.gen
	c.gen = newGeneration(c.deps)
	c.mu.Unlock()
	old.stop()
}

func (c *Cell) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if reason := c.authorize(r.Header.Values("Proxy-Authorization")); reason != "" {
		c.refuseAuth(w, r, reason)
		return
	}
	r.Header.Del("Proxy-Authorization")
	line := audit.Line{Kind: audit.KindRequest, Method: r.Method, Host: r.URL.Hostname(), Path: r.URL.Path}
	switch {
	case r.Method == http.MethodConnect:
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
	case !r.URL.IsAbs() || r.URL.Scheme != "http":
		c.deny(w, line, http.StatusBadRequest, ReasonBadRequest)
	case strings.EqualFold(r.URL.Hostname(), internalHost):
		c.serveInternal(w, r)
	default:
		c.servePlain(w, r)
	}
}

// authorize accepts only Basic credentials whose password is the cell's token.
func (c *Cell) authorize(values []string) string {
	if len(values) == 0 {
		return ReasonAuthMissing
	}
	scheme, encoded, ok := strings.Cut(values[0], " ")
	if len(values) > 1 || !ok || !strings.EqualFold(scheme, "Basic") {
		return ReasonAuthInvalid
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return ReasonAuthInvalid
	}
	_, pass, ok := strings.Cut(string(raw), ":")
	if !ok || subtle.ConstantTimeCompare([]byte(pass), []byte(c.cfg.Token)) != 1 {
		return ReasonAuthInvalid
	}
	return ""
}

// refuseAuth answers 407. Any container with egress can reach the listener, so refusals are
// audited at most once a second, with the number left out.
func (c *Cell) refuseAuth(w http.ResponseWriter, r *http.Request, reason string) {
	if ok, suppressed := c.authLog.allow(time.Now()); ok {
		l := audit.Line{Kind: audit.KindRequest, Method: r.Method, Host: r.URL.Hostname(), Decision: audit.Deny, Reason: reason, Status: http.StatusProxyAuthRequired}
		if r.Method == http.MethodConnect {
			l.Kind, l.Host = audit.KindConnect, r.Host
		}
		if suppressed > 0 {
			l.Detail = fmt.Sprintf("%d earlier refusals not logged", suppressed)
		}
		c.record(l)
	}
	w.Header().Set("Proxy-Authenticate", `Basic realm="localdot-keyd"`)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: proxy authentication required", http.StatusProxyAuthRequired)
}

func (c *Cell) deny(w http.ResponseWriter, l audit.Line, status int, reason string) {
	l.Decision, l.Reason, l.Status = audit.Deny, reason, status
	c.record(l)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: "+reason, status)
}

var alerts = map[string]bool{
	keys.ReasonUnknownSurrogate:   true,
	keys.ReasonMisplacedSurrogate: true,
	keys.ReasonSurrogatePolicy:    true,
}

// record writes the audit line and, for every use or misuse of a surrogate, a key.use event made
// from the line as written, so the event carries no surrogate either.
func (c *Cell) record(l audit.Line) {
	l.Cell, l.Port = c.cfg.CellID, c.Port()
	l, err := c.deps.Audit.Write(l)
	if err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
	if l.SecretID == "" && !alerts[l.Reason] {
		return
	}
	secret, decision := l.SecretID, "deny"
	if secret == "" {
		secret = "unknown"
	}
	if l.Swapped {
		decision = "allow"
	}
	c.deps.Events.Publish(events.Event{Type: events.TypeKeyUse, Cell: c.cfg.CellID, Data: events.KeyUse{
		SecretID: secret, Host: l.Host, Method: l.Method, Path: l.Path, Decision: decision,
	}})
}

func (c *Cell) current() *generation {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

type rateLog struct {
	mu         sync.Mutex
	last       time.Time
	suppressed int
}

func (r *rateLog) allow(now time.Time) (bool, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.last) < time.Second {
		r.suppressed++
		return false, 0
	}
	n := r.suppressed
	r.last, r.suppressed = now, 0
	return true, n
}
```

`keyd/internal/egress/internal.go`:
```go
package egress

import (
	"encoding/json"
	"net/http"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
)

// serveInternal answers keyd.ldot, the name a cell's boot self-test uses to prove its proxy path
// and token without reaching the internet.
func (c *Cell) serveInternal(w http.ResponseWriter, r *http.Request) {
	line := audit.Line{Kind: audit.KindRequest, Mode: "internal", Method: r.Method, Host: internalHost, Path: r.URL.Path}
	if r.URL.Path != "/health" {
		c.deny(w, line, http.StatusNotFound, ReasonNotFound)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
		return
	}
	line.Decision, line.Status = audit.Allow, http.StatusOK
	c.record(line)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "cell": c.cfg.CellID})
}
```

`keyd/internal/egress/forward.go`:
```go
package egress

import (
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/scrub"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const redacted = "keyd-redacted"

var errEncoding = errors.New("egress: upstream used a content encoding keyd cannot scrub")

// route is one request keyd forwards: where it goes and the audit line it will close.
type route struct {
	dest   keys.Dest
	target *url.URL
	line   audit.Line
	gen    *generation
}

func (c *Cell) servePlain(w http.ResponseWriter, r *http.Request) {
	line := audit.Line{Kind: audit.KindRequest, Mode: "http", Method: r.Method, Host: r.URL.Hostname(), Path: r.URL.Path}
	// A plain request never carries a surrogate. Looking before the host is checked catches one in
	// the host name too, which would otherwise be refused as an invalid name without an alert.
	if v := c.deps.Registry.Inspect(keys.Dest{Cell: c.cfg.CellID, Scheme: "http"}, r.Method, r.URL, r.Header); !v.Allow {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	t, reason := policy.ParseHostPort(r.URL.Host, 80)
	if reason != "" {
		c.deny(w, line, http.StatusForbidden, reason)
		return
	}
	line.Host = t.Host
	if d := c.cfg.Policy.PlainHTTP(t); !d.Allow {
		c.deny(w, line, http.StatusForbidden, d.Reason)
		return
	}
	target := &url.URL{Scheme: "http", Host: t.Host, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
	c.forward(w, r, route{dest: keys.Dest{Cell: c.cfg.CellID, Scheme: "http", Host: t.Host}, target: target, line: line, gen: c.current()})
}

// forward checks a request bound for a host and swaps the surrogates it may carry, then relays it.
func (c *Cell) forward(w http.ResponseWriter, r *http.Request, rt route) {
	line := rt.line
	if r.Method == "TRACE" || r.Method == "TRACK" {
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
		return
	}
	if isUpgrade(r) && (rt.dest.Scheme != "http" || c.intercepted[rt.dest.Host]) {
		c.deny(w, line, http.StatusForbidden, ReasonUpgrade)
		return
	}
	v := c.deps.Registry.Inspect(rt.dest, r.Method, r.URL, r.Header)
	line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
	if !v.Allow {
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	if status, reason := c.swap(r.Header, v.Swaps); reason != "" {
		c.deny(w, line, status, reason)
		return
	}
	line.Swapped = len(v.Swaps) > 0
	scrubber, err := c.scrubberFor(rt.dest)
	if err != nil {
		c.deny(w, line, http.StatusBadGateway, ReasonSecret)
		return
	}
	c.relay(w, r, rt, scrubber, line)
}

// swap puts the real values in. While the audit log cannot be written it refuses: the use of a
// secret is never left unrecorded.
func (c *Cell) swap(h http.Header, swaps []keys.Entry) (int, string) {
	if len(swaps) == 0 {
		return 0, ""
	}
	if c.deps.Audit.Err() != nil {
		return http.StatusServiceUnavailable, ReasonNoAudit
	}
	if err := keys.ApplySwaps(h, swaps, c.deps.Vault.Value); err != nil {
		return http.StatusBadGateway, ReasonSecret
	}
	return 0, ""
}

// relay sends the request with the generation's transport: verified upstream TLS, guarded dials,
// no other proxy, no redirects followed. The response is scrubbed on its way back, and the audit
// line is written once the body has been relayed or the attempt has failed.
func (c *Cell) relay(w http.ResponseWriter, r *http.Request, rt route, scrubber *scrub.Scrubber, line audit.Line) {
	start := time.Now()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer context.AfterFunc(rt.gen.ctx, cancel)()
	in := &counter{ReadCloser: r.Body}
	r.Body = in
	var once sync.Once
	finish := func(l audit.Line) {
		once.Do(func() {
			l.BytesIn, l.DurationMs = in.n, msSince(start)
			c.record(l)
		})
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			target := *rt.target
			pr.Out.URL = &target
			pr.Out.Host = ""
			pr.Out.Header.Set("Accept-Encoding", "gzip")
		},
		Transport:     rt.gen.tr,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ModifyResponse: func(resp *http.Response) error {
			l := line
			l.Decision, l.Status = audit.Allow, resp.StatusCode
			if !bodyAllowed(r.Method, resp.StatusCode) {
				scrubber.Header(resp.Header)
				finish(l)
				return nil
			}
			gzipped, ok := coding(resp.Header.Values("Content-Encoding"))
			if !ok {
				return errEncoding
			}
			if gzipped {
				resp.Header.Del("Content-Encoding")
				resp.Body = &gunzip{body: resp.Body}
			}
			scrubber.Header(resp.Header)
			resp.Header.Del("Content-Length")
			resp.ContentLength = -1
			resp.Body = &tally{
				ReadCloser: scrubber.Reader(resp.Body),
				atEOF:      func() { scrubber.Header(resp.Trailer) },
				done: func(n int64, eof bool, err error) {
					l.BytesOut = n
					c.streamOutcome(&l, eof, err, r.Context(), rt.gen)
					finish(l)
				},
			}
			return nil
		},
		ErrorHandler: func(rw http.ResponseWriter, _ *http.Request, err error) {
			status, decision, reason := c.failure(err, r.Context(), rt.gen)
			l := line
			l.Decision, l.Reason, l.Status, l.Detail = decision, reason, status, err.Error()
			finish(l)
			if reason == ReasonClientGone {
				return
			}
			rw.Header().Set("X-Keyd-Reason", reason)
			http.Error(rw, "keyd: "+reason, status)
		},
	}
	proxy.ServeHTTP(scrubbedWriter{ResponseWriter: w, s: scrubber}, r.WithContext(ctx))
}

// scrubbedWriter scrubs the headers of informational responses, which ReverseProxy relays as they
// arrive, before ModifyResponse sees anything.
type scrubbedWriter struct {
	http.ResponseWriter
	s *scrub.Scrubber
}

func (w scrubbedWriter) WriteHeader(code int) {
	if code < 200 {
		w.s.Header(w.ResponseWriter.Header())
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w scrubbedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// scrubberFor collects every secret bound to the destination; each is replaced by this cell's
// surrogate for it, or by a marker when the cell holds none.
func (c *Cell) scrubberFor(d keys.Dest) (*scrub.Scrubber, error) {
	mine := map[string]string{}
	for _, e := range c.deps.Registry.ForCell(c.cfg.CellID) {
		mine[e.Binding.SecretID] = e.Token
	}
	var pairs []scrub.Pair
	for _, rec := range c.deps.Vault.Records() {
		b, err := keys.FromRecord(rec)
		if err != nil {
			continue
		}
		hit := (rec.Kind == vault.KindHTTP && slices.Contains(b.Hosts, d.Host)) || (d.Scheme == "gateway" && b.Route == d.Route)
		if !hit {
			continue
		}
		value, err := c.deps.Vault.Value(rec.ID)
		if err != nil {
			return nil, err
		}
		repl := mine[rec.ID]
		if repl == "" {
			repl = redacted
		}
		pairs = append(pairs, scrub.Pair{Secret: value, Replacement: []byte(repl)})
	}
	return scrub.New(pairs...)
}

func (c *Cell) streamOutcome(l *audit.Line, eof bool, err error, reqCtx context.Context, g *generation) {
	switch {
	case eof && err == nil:
		return
	case g.ctx.Err() != nil:
		l.Decision, l.Reason = audit.Error, ReasonRevoked
	case reqCtx.Err() != nil:
		l.Decision, l.Reason = audit.Error, ReasonClientGone
	default:
		l.Decision, l.Reason = audit.Error, ReasonAborted
		if err != nil {
			l.Detail = err.Error()
		}
	}
}

// failure maps an error from before the response into a status, a decision and a reason.
func (c *Cell) failure(err error, reqCtx context.Context, g *generation) (int, string, string) {
	if errors.Is(err, errEncoding) {
		return http.StatusBadGateway, audit.Error, ReasonEncoding
	}
	if decision, reason := dialOutcome(err); reason != ReasonUpstream {
		status := http.StatusBadGateway
		if reason == ReasonAddress {
			status = http.StatusForbidden
		}
		return status, decision, reason
	}
	switch {
	case g.ctx.Err() != nil:
		return http.StatusServiceUnavailable, audit.Error, ReasonRevoked
	case reqCtx.Err() != nil:
		return 0, audit.Error, ReasonClientGone
	}
	return http.StatusBadGateway, audit.Error, ReasonUpstream
}

func dialOutcome(err error) (string, string) {
	var denied *netguard.DeniedError
	var resolve *netguard.ResolveError
	var cert *tls.CertificateVerificationError
	switch {
	case errors.As(err, &denied):
		return audit.Deny, ReasonAddress
	case errors.As(err, &resolve):
		return audit.Error, ReasonResolve
	case errors.As(err, &cert):
		return audit.Error, ReasonUpstreamTLS
	}
	return audit.Error, ReasonUpstream
}

// coding reads a response's Content-Encoding lines. Nothing, or a lone identity, leaves the body
// as it is; a lone gzip, which keyd asked for, is decoded so the scrubber reads the text. Any
// other coding, or more than one on any number of lines, is refused: a client would decode what
// keyd let by.
func coding(values []string) (gzipped, ok bool) {
	var codings []string
	for _, v := range values {
		for _, c := range strings.Split(v, ",") {
			if c = strings.TrimSpace(c); c != "" {
				codings = append(codings, strings.ToLower(c))
			}
		}
	}
	switch {
	case len(codings) == 0 || len(codings) == 1 && codings[0] == "identity":
		return false, true
	case len(codings) == 1 && codings[0] == "gzip":
		return true, true
	}
	return false, false
}

// gunzip decodes a gzip body as it is read, so a stream's first bytes do not wait.
type gunzip struct {
	body io.ReadCloser
	zr   *gzip.Reader
	err  error
}

func (g *gunzip) Read(p []byte) (int, error) {
	if g.zr == nil && g.err == nil {
		g.zr, g.err = gzip.NewReader(g.body)
	}
	if g.err != nil {
		return 0, g.err
	}
	return g.zr.Read(p)
}

func (g *gunzip) Close() error { return g.body.Close() }

func isUpgrade(r *http.Request) bool {
	return r.Header.Get("Upgrade") != "" || slices.ContainsFunc(r.Header.Values("Connection"), func(v string) bool {
		return strings.Contains(strings.ToLower(v), "upgrade")
	})
}

func bodyAllowed(method string, status int) bool {
	return method != http.MethodHead && status >= 200 && status != http.StatusNoContent && status != http.StatusNotModified
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000
}

type counter struct {
	io.ReadCloser
	n int64
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	c.n += int64(n)
	return n, err
}

// tally counts what reaches the client and reports once, on Close, how the stream ended.
type tally struct {
	io.ReadCloser
	n     int64
	eof   bool
	err   error
	atEOF func()
	done  func(n int64, eof bool, err error)
	once  sync.Once
}

func (t *tally) Read(p []byte) (int, error) {
	n, err := t.ReadCloser.Read(p)
	t.n += int64(n)
	switch {
	case err == io.EOF:
		if !t.eof {
			t.eof = true
			t.atEOF()
		}
	case err != nil:
		t.err = err
	}
	return n, err
}

func (t *tally) Close() error {
	err := t.ReadCloser.Close()
	t.once.Do(func() { t.done(t.n, t.eof, t.err) })
	return err
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/egress/`
Expected: `ok` (16 tests). The module has no dependency yet; `go.mod` is still Task 1's.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/egress
git commit -m "feat(keyd): per-cell listener with token auth and plain HTTP"
```

---
