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
