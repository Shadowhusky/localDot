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
	"strings"
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

const (
	testToken        = "test-proxy-token-0123456789abcdefghijklmnopq"
	testCaptureToken = "test-capture-token-0123456789abcdefghijklmn"
	// Long enough for a test to answer, short enough that one that does not still ends.
	testAskHold = 3 * time.Second
)

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
	host = strings.TrimSuffix(host, ".")
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
	d, address := p.dialer(address)
	return d.DialContext(ctx, network, address)
}

func (p portMap) Check(ctx context.Context, network, address string) error {
	d, address := p.dialer(address)
	return d.Check(ctx, network, address)
}

func (p portMap) dialer(address string) (*netguard.Dialer, string) {
	// keyd dials absolute names; the world knows them without the dot.
	if host, port, err := net.SplitHostPort(address); err == nil {
		address = net.JoinHostPort(strings.TrimSuffix(host, "."), port)
	}
	p.w.mu.Lock()
	if mapped, ok := p.w.ports[address]; ok {
		address = mapped
	}
	allow := append([]netip.AddrPort(nil), p.w.allow...)
	own := append([]netip.Prefix(nil), p.w.own...)
	p.w.mu.Unlock()
	return &netguard.Dialer{Guard: netguard.New(func() ([]netip.Prefix, error) { return own, nil }, allow...), Resolver: p.w}, address
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
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken, CaptureToken: testCaptureToken, AskHold: testAskHold}, w.deps())
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
