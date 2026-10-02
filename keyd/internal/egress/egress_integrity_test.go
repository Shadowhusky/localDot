package egress

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// recordingDialer notes every address egress asks for, then dials through the world.
type recordingDialer struct {
	next Dialer
	mu   sync.Mutex
	seen []string
}

func (d *recordingDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	d.seen = append(d.seen, address)
	d.mu.Unlock()
	return d.next.DialContext(ctx, network, address)
}

func (d *recordingDialer) addresses() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.seen...)
}

// recordingCell opens a cell whose dials are recorded.
func (w *world) recordingCell(id string, role policy.Role) (*Cell, *recordingDialer) {
	w.t.Helper()
	rd := &recordingDialer{next: portMap{w}}
	return w.cellWith(id, role, rd), rd
}

func (w *world) cellWith(id string, role policy.Role, d Dialer) *Cell {
	w.t.Helper()
	p, err := policy.ForRole(role)
	if err != nil {
		w.t.Fatal(err)
	}
	deps := w.deps()
	deps.Dialer = d
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken}, deps)
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { c.Close() })
	return c
}

// A relative name would go through the resolver's search domains; keyd dials the absolute name,
// while the upstream still sees the name without the dot.
func TestPlainHTTPDialsTheAbsoluteName(t *testing.T) {
	w := newWorld(t)
	seen := make(chan string, 1)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Host
		io.WriteString(rw, "ok")
	}))
	c, rd := w.recordingCell("c1", policy.Desktop)
	for _, u := range []string{"http://ports.example.test/", "http://ports.example.test./", "http://PORTS.example.test:80/"} {
		resp, body := get(t, w.client(c), u)
		if resp.StatusCode != 200 || body != "ok" {
			t.Fatalf("%s: %d %q", u, resp.StatusCode, body)
		}
		if host := <-seen; host != "ports.example.test" {
			t.Fatalf("%s: upstream saw Host %q", u, host)
		}
	}
	for _, a := range rd.addresses() {
		if a != "ports.example.test.:80" {
			t.Fatalf("dialled %q, want the absolute name", a)
		}
	}
	if len(rd.addresses()) == 0 {
		t.Fatal("nothing dialled")
	}
}

const echoed = "real-secret-value-for-test"

// sendRaw writes req to the cell's listener and returns everything it answers until it closes.
func sendRaw(t *testing.T, c *Cell, req string) string {
	t.Helper()
	conn, err := dialListener(c)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(conn, req); err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(conn)
	return string(raw)
}

// rawRequest sends one request and reads its response, body included.
func rawRequest(t *testing.T, c *Cell, req string) (*http.Response, string) {
	t.Helper()
	raw := sendRaw(t, c, req)
	resp, err := http.ReadResponse(bufio.NewReader(strings.NewReader(raw)), nil)
	if err != nil {
		t.Fatalf("response %q: %v", raw, err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("body of %q: %v", raw, err)
	}
	return resp, string(body)
}

func proxyAuth() string { return "Proxy-Authorization: Basic " + basicAuth("cell", testToken) + "\r\n" }

// rawUpstream answers each connection's first request with what reply returns for its path.
func (w *world) rawUpstream(host string, reply func(*http.Request) string) {
	w.t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				req, err := http.ReadRequest(bufio.NewReader(conn))
				if err != nil {
					return
				}
				io.Copy(io.Discard, req.Body)
				io.WriteString(conn, reply(req))
			}()
		}
	}()
	w.publish(host, "80", ln.Addr().String(), true)
}

func (w *world) auditText() string {
	w.t.Helper()
	data, err := os.ReadFile(w.auditPath)
	if err != nil {
		w.t.Fatal(err)
	}
	return string(data)
}

// A plain request is inspected before its host is checked: a surrogate anywhere in it, known or
// not, is refused and alerted, and nothing is dialled.
func TestSurrogatesAreRefusedAndAlertedBeforeAnyDial(t *testing.T) {
	w := newWorld(t)
	var reached atomic.Bool
	w.plainUpstream("api.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, echoed)
	c, rd := w.recordingCell("c1", policy.Desktop)
	known := w.mint("c1", "weather")
	unknown, _ := surrogate.Mint("key")
	sub, cancel := w.events.Subscribe(64)
	defer cancel()
	for _, tc := range []struct {
		tok, reason string
	}{{known, keys.ReasonMisplacedSurrogate}, {unknown, keys.ReasonUnknownSurrogate}} {
		tok := tc.tok
		for _, target := range []string{
			"http://" + tok + ".example.test/",
			"http://" + tok + "/",
			"http://" + tok + ".local/",
			"http://" + tok + ".example.test:8080/",
			"http://api.example.test/" + tok,
			"http://api.example.test/%6c" + tok[1:],
			"http://api.example.test/?k=" + tok,
			"http://api.example.test/?k=%6c" + tok[1:],
			"http://u:" + tok + "@api.example.test/",
			"http://" + tok + "@api.example.test/",
			"http://api.example.test/#" + tok,
		} {
			resp, _ := rawRequest(t, c, "GET "+target+" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"+proxyAuth()+"\r\n")
			if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != tc.reason {
				t.Errorf("%s: %d %q, want 403 %q", target, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), tc.reason)
			}
		}
		for _, header := range []string{"Authorization: Bearer " + tok, "X-Note: " + tok, "Cookie: a=" + tok} {
			resp, _ := rawRequest(t, c, "GET http://api.example.test/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"+header+"\r\n"+proxyAuth()+"\r\n")
			if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != tc.reason {
				t.Errorf("%s: %d %q, want 403 %q", header, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), tc.reason)
			}
		}
	}
	if a := rd.addresses(); len(a) != 0 || reached.Load() {
		t.Fatalf("dialled %v, upstream reached %v", a, reached.Load())
	}
	alerts := 0
	for len(sub) > 0 {
		e := <-sub
		ku, ok := e.Data.(events.KeyUse)
		if !ok || e.Type != events.TypeKeyUse || ku.Decision != "deny" {
			t.Fatalf("event %+v", e)
		}
		if strings.Contains(ku.Host+ku.Path, known) || strings.Contains(ku.Host+ku.Path, unknown) {
			t.Fatalf("key.use carries a surrogate: %+v", ku)
		}
		alerts++
	}
	if alerts != 28 {
		t.Fatalf("%d key.use alerts for 28 refusals", alerts)
	}
	logged := w.auditText()
	if strings.Contains(logged, known) || strings.Contains(logged, unknown) || strings.Contains(logged, testToken) {
		t.Fatalf("audit carries a surrogate or the token: %s", logged)
	}
}

// The Host header never decides where a request goes, and a surrogate in it never reaches the
// upstream.
func TestTheRequestURIDecidesNotTheHostHeader(t *testing.T) {
	w := newWorld(t)
	seen := make(chan string, 4)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Host
	}))
	c, rd := w.recordingCell("c1", policy.Desktop)
	if resp, _ := rawRequest(t, c, "GET http://printer.local/ HTTP/1.1\r\nHost: ports.example.test\r\nConnection: close\r\n"+proxyAuth()+"\r\n"); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != policy.ReasonHostDenied {
		t.Fatalf("denied URI host, allowed Host header: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	tok, _ := surrogate.Mint("key")
	for _, host := range []string{"printer.local", tok + ".example.test"} {
		if resp, _ := rawRequest(t, c, "GET http://ports.example.test/ HTTP/1.1\r\nHost: "+host+"\r\nConnection: close\r\n"+proxyAuth()+"\r\n"); resp.StatusCode != http.StatusOK {
			t.Fatalf("Host %s: %d", host, resp.StatusCode)
		}
		if got := <-seen; got != "ports.example.test" {
			t.Fatalf("upstream saw Host %q", got)
		}
	}
	for _, a := range rd.addresses() {
		if a != "ports.example.test.:80" {
			t.Fatalf("dialled %q", a)
		}
	}
}

// keyd sends the upstream only the request: no proxy credentials, nothing the cell listed as
// hop-by-hop, no forwarding headers, and its own Accept-Encoding.
func TestTheUpstreamSeesNoProxyOrHopByHopHeaders(t *testing.T) {
	w := newWorld(t)
	seen := make(chan *http.Request, 1)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		io.ReadAll(r.Body)
		seen <- r.Clone(context.Background())
	}))
	c := w.cell("c1", policy.Desktop)
	resp, _ := rawRequest(t, c, "POST http://PORTS.example.test.:80/up HTTP/1.1\r\nHost: x\r\nConnection: close, X-Hop, Proxy-Authorization\r\n"+proxyAuth()+
		"X-Hop: 1\r\nProxy-Connection: keep-alive\r\nKeep-Alive: timeout=5\r\nX-Forwarded-For: 10.0.0.1\r\nX-Forwarded-Host: printer.local\r\nForwarded: for=10.0.0.1\r\nAccept-Encoding: br, zstd\r\nContent-Length: 7\r\n\r\npayload")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("%d", resp.StatusCode)
	}
	r := <-seen
	for _, name := range []string{"Proxy-Authorization", "X-Hop", "Proxy-Connection", "Keep-Alive", "X-Forwarded-For", "X-Forwarded-Host", "Forwarded"} {
		if v := r.Header.Values(name); len(v) > 0 {
			t.Errorf("upstream saw %s: %v", name, v)
		}
	}
	if got := r.Header.Values("Accept-Encoding"); len(got) != 1 || got[0] != "gzip" {
		t.Errorf("upstream saw Accept-Encoding %v, want keyd's gzip", got)
	}
	if r.Host != "ports.example.test" {
		t.Errorf("upstream saw Host %q", r.Host)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "http" && l.Decision == audit.Allow })
	if l.Host != "ports.example.test" || l.Path != "/up" || l.BytesIn != 7 {
		t.Fatalf("audit %+v", l)
	}
}

func TestExpectContinueIsCheckedBeforeAnyDial(t *testing.T) {
	w := newWorld(t)
	got := make(chan string, 1)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- string(b)
	}))
	c, rd := w.recordingCell("c1", policy.Desktop)
	if resp, _ := rawRequest(t, c, "POST http://printer.local/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\nExpect: 100-continue\r\nContent-Length: 5\r\n"+proxyAuth()+"\r\n"); resp.StatusCode != http.StatusForbidden {
		t.Fatalf("denied host: %d", resp.StatusCode)
	}
	if a := rd.addresses(); len(a) != 0 {
		t.Fatalf("dialled %v", a)
	}
	raw := sendRaw(t, c, "POST http://ports.example.test/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\nExpect: 100-continue\r\nContent-Length: 5\r\n"+proxyAuth()+"\r\nhello")
	if !strings.Contains(raw, "HTTP/1.1 200") || <-got != "hello" {
		t.Fatalf("allowed host: %q", raw)
	}
}

// Only absolute http:// requests are served; CONNECT waits for its own task, and nothing is dialled.
func TestOnlyAbsoluteHTTPIsServed(t *testing.T) {
	w := newWorld(t)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	c, rd := w.recordingCell("c1", policy.Desktop)
	for req, want := range map[string]int{
		"CONNECT ports.example.test:443 HTTP/1.1\r\nHost: ports.example.test:443\r\n":   http.StatusMethodNotAllowed,
		"CONNECT ports.example.test:80 HTTP/1.1\r\nHost: ports.example.test:80\r\n":     http.StatusMethodNotAllowed,
		"GET https://ports.example.test/ HTTP/1.1\r\nHost: ports.example.test\r\n":      http.StatusBadRequest,
		"GET ftp://ports.example.test/ HTTP/1.1\r\nHost: ports.example.test\r\n":        http.StatusBadRequest,
		"GET ws://ports.example.test/ HTTP/1.1\r\nHost: ports.example.test\r\n":         http.StatusBadRequest,
		"GET /http://ports.example.test/ HTTP/1.1\r\nHost: ports.example.test\r\n":      http.StatusBadRequest,
		"POST http://keyd.ldot/health HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n":     http.StatusMethodNotAllowed,
		"GET http://keyd.ldot./health HTTP/1.1\r\nHost: x\r\n":                          http.StatusForbidden,
		"GET http://api.keyd.ldot/health HTTP/1.1\r\nHost: x\r\n":                       http.StatusForbidden,
		"TRACE http://ports.example.test/ HTTP/1.1\r\nHost: x\r\n":                      http.StatusMethodNotAllowed,
		"GET http://ports.example.test:443/ HTTP/1.1\r\nHost: ports.example.test\r\n":   http.StatusForbidden,
		"GET http://ports.example.test:080/ HTTP/1.1\r\nHost: ports.example.test\r\n":   http.StatusForbidden,
		"GET http://ports.example.test:+80/ HTTP/1.1\r\nHost: ports.example.test\r\n":   http.StatusBadRequest,
		"GET http://[ports.example.test]/ HTTP/1.1\r\nHost: ports.example.test\r\n":     http.StatusBadRequest,
		"GET http://ports/ HTTP/1.1\r\nHost: ports.example.test\r\n":                    http.StatusForbidden,
		"GET http://0x7f.0x1/ HTTP/1.1\r\nHost: ports.example.test\r\n":                 http.StatusForbidden,
		"GET http://2130706433/ HTTP/1.1\r\nHost: ports.example.test\r\n":               http.StatusForbidden,
		"GET http://ports.example.test.local/ HTTP/1.1\r\nHost: ports.example.test\r\n": http.StatusForbidden,
	} {
		resp, _ := rawRequest(t, c, req+"Connection: close\r\n"+proxyAuth()+"\r\n")
		if resp.StatusCode != want {
			t.Errorf("%q: %d, want %d", req, resp.StatusCode, want)
		}
	}
	if a := rd.addresses(); len(a) != 0 {
		t.Fatalf("dialled %v", a)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "internal" && l.Reason == ReasonMethod })
	if l.Decision != audit.Deny || l.Status != http.StatusMethodNotAllowed {
		t.Fatalf("audit %+v", l)
	}
}

func TestHealthIsAudited(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c-health", policy.Brain)
	if resp, _ := get(t, w.client(c), "http://KEYD.ldot/health"); resp.StatusCode != http.StatusOK {
		t.Fatalf("%d", resp.StatusCode)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "internal" })
	if l.Decision != audit.Allow || l.Status != http.StatusOK || l.Host != "keyd.ldot" || l.Path != "/health" || l.Cell != "c-health" {
		t.Fatalf("audit %+v", l)
	}
}

// Proxy credentials are exactly one canonical Basic header whose password is the token.
func TestProxyCredentialsAreExact(t *testing.T) {
	w := newWorld(t)
	c, rd := w.recordingCell("c1", policy.Desktop)
	good := basicAuth("cell", testToken)
	for name, header := range map[string]string{
		"second line":     "Proxy-Authorization: Basic " + good + "\r\nProxy-Authorization: Basic " + basicAuth("cell", "other") + "\r\n",
		"trailing junk":   "Proxy-Authorization: Basic " + good + "!!!!\r\n",
		"another scheme":  "Proxy-Authorization: Bearer " + testToken + "\r\n",
		"token as user":   "Proxy-Authorization: Basic " + basicAuth(testToken, "") + "\r\n",
		"token prefix":    "Proxy-Authorization: Basic " + basicAuth("cell", testToken[:len(testToken)-1]) + "\r\n",
		"token and more":  "Proxy-Authorization: Basic " + basicAuth("cell", testToken+"x") + "\r\n",
		"no colon":        "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(testToken)) + "\r\n",
		"scheme only":     "Proxy-Authorization: Basic\r\n",
		"plain authorize": "Authorization: Basic " + good + "\r\n",
	} {
		resp, _ := rawRequest(t, c, "GET http://keyd.ldot/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n"+header+"\r\n")
		if resp.StatusCode != http.StatusProxyAuthRequired {
			t.Errorf("%s: %d", name, resp.StatusCode)
		}
	}
	for _, scheme := range []string{"Basic", "basic", "BASIC"} {
		resp, _ := rawRequest(t, c, "GET http://keyd.ldot/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\nProxy-Authorization: "+scheme+" "+good+"\r\n\r\n")
		if resp.StatusCode != http.StatusOK {
			t.Errorf("scheme %s: %d", scheme, resp.StatusCode)
		}
	}
	if a := rd.addresses(); len(a) != 0 {
		t.Fatalf("dialled %v", a)
	}
	if logged := w.auditText(); strings.Contains(logged, testToken) || strings.Contains(logged, good) {
		t.Fatalf("audit carries the token: %s", logged)
	}
}

// The first refusal is audited, with a CONNECT named as one; the rest of that second are counted
// into the next line.
func TestAuthRefusalAuditsAreSpacedAndCounted(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	conn, err := dialListener(c)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n")
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if status, _ := bufio.NewReader(conn).ReadString('\n'); status != "HTTP/1.1 407 Proxy Authentication Required\r\n" {
		t.Fatalf("CONNECT: %q", status)
	}
	time.Sleep(300 * time.Millisecond)
	for range 3 {
		get(t, withToken(c, ""), "http://keyd.ldot/health")
	}
	time.Sleep(time.Second)
	get(t, withToken(c, ""), "http://keyd.ldot/health")
	var refusals []audit.Line
	for _, l := range w.lines() {
		if l.Reason == ReasonAuthMissing {
			refusals = append(refusals, l)
		}
	}
	if len(refusals) != 2 {
		t.Fatalf("%d audit lines, want 2: %+v", len(refusals), refusals)
	}
	if l := refusals[0]; l.Kind != audit.KindConnect || l.Host != "example.com:443" || l.Detail != "" {
		t.Fatalf("first %+v", l)
	}
	if l := refusals[1]; l.Kind != audit.KindRequest || l.Host != "keyd.ldot" || l.Detail != "3 earlier refusals not logged" {
		t.Fatalf("second %+v", l)
	}
}

// Everything keyd relays from a plain upstream is scrubbed: headers of every response, 1xx
// included, bodies whatever their length, a lone gzip, and trailers; the reason phrase is keyd's.
func TestEveryPartOfAResponseIsScrubbed(t *testing.T) {
	w := newWorld(t)
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, echoed)
	var zipped bytes.Buffer
	zw := gzip.NewWriter(&zipped)
	io.WriteString(zw, "echo "+echoed)
	zw.Close()
	w.rawUpstream("api.example.test", func(r *http.Request) string {
		const end = "Connection: close\r\n"
		switch r.URL.Path {
		case "/reason":
			return "HTTP/1.1 200 " + echoed + "\r\nContent-Length: 2\r\n" + end + "\r\nok"
		case "/early":
			return "HTTP/1.1 103 Early Hints\r\nLink: <" + echoed + ">\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n" + end + "\r\nok"
		case "/trailer":
			return "HTTP/1.1 200 OK\r\nTrailer: X-T\r\nTransfer-Encoding: chunked\r\n" + end + "\r\n4\r\nbody\r\n0\r\nX-T: " + echoed + "\r\nX-U: " + echoed + "\r\n\r\n"
		case "/length":
			return "HTTP/1.1 200 OK\r\nX-H: " + echoed + "\r\nContent-Length: 30\r\n" + end + "\r\n" + echoed + "abcd"
		case "/gzip":
			return "HTTP/1.1 200 OK\r\nContent-Encoding: GZip\r\nContent-Length: " + strconv.Itoa(zipped.Len()) + "\r\n" + end + "\r\n" + zipped.String()
		case "/head":
			return "HTTP/1.1 200 OK\r\nX-H: " + echoed + "\r\nContent-Length: 30\r\n" + end + "\r\n"
		case "/204":
			return "HTTP/1.1 204 No Content\r\nX-H: " + echoed + "\r\n" + end + "\r\n"
		case "/304":
			return "HTTP/1.1 304 Not Modified\r\nX-H: " + echoed + "\r\n" + end + "\r\n"
		}
		return "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n" + end + "\r\n"
	})
	c := w.cell("c1", policy.Desktop)
	ask := func(method, path string) string {
		raw := sendRaw(t, c, method+" http://api.example.test"+path+" HTTP/1.1\r\nHost: x\r\nConnection: close\r\nTE: trailers\r\n"+proxyAuth()+"\r\n")
		if strings.Contains(raw, echoed) {
			t.Errorf("%s %s relayed the secret: %q", method, path, raw)
		}
		return raw
	}
	if raw := ask("GET", "/reason"); !strings.HasPrefix(raw, "HTTP/1.1 200 OK\r\n") {
		t.Errorf("reason phrase: %q", raw)
	}
	if raw := ask("GET", "/early"); !strings.HasPrefix(raw, "HTTP/1.1 103 Early Hints\r\nLink: <"+redacted+">\r\n") {
		t.Errorf("1xx: %q", raw)
	}
	if raw := ask("GET", "/trailer"); !strings.Contains(raw, "X-T: "+redacted+"\r\n") || !strings.Contains(raw, "X-U: "+redacted+"\r\n") {
		t.Errorf("trailers: %q", raw)
	}
	for path, want := range map[string]string{"/length": redacted + "abcd", "/gzip": "echo " + redacted} {
		resp, err := http.ReadResponse(bufio.NewReader(strings.NewReader(ask("GET", path))), nil)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		if err != nil || string(body) != want || resp.Header.Get("Content-Encoding") != "" {
			t.Errorf("%s: %q %v %v", path, body, err, resp.Header)
		}
		if path == "/length" && resp.Header.Get("X-H") != redacted {
			t.Errorf("header: %v", resp.Header)
		}
	}
	for _, mp := range [][2]string{{"HEAD", "/head"}, {"GET", "/204"}, {"GET", "/304"}} {
		raw := ask(mp[0], mp[1])
		if !strings.Contains(raw, "X-H: "+redacted+"\r\n") {
			t.Errorf("%s %s: %q", mp[0], mp[1], raw)
		}
		if mp[0] == "HEAD" && !strings.Contains(raw, "Content-Length: 30\r\n") {
			t.Errorf("HEAD lost its Content-Length: %q", raw)
		}
	}
	if logged := w.auditText(); strings.Contains(logged, echoed) {
		t.Fatalf("audit carries the secret: %s", logged)
	}
}

// An echo of a secret comes back as the cell's own surrogate for it, or as keyd-redacted for a
// cell that holds none.
func TestAnEchoBecomesTheCellsOwnSurrogate(t *testing.T) {
	w := newWorld(t)
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, echoed)
	w.plainUpstream("api.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		io.WriteString(rw, "key="+echoed)
	}))
	holder := w.cell("c1", policy.Desktop)
	other := w.cell("c2", policy.Desktop)
	tok := w.mint("c1", "weather")
	if _, body := get(t, w.client(holder), "http://api.example.test/"); body != "key="+tok {
		t.Errorf("holder got %q", body)
	}
	if _, body := get(t, w.client(other), "http://api.example.test/"); body != "key="+redacted {
		t.Errorf("other cell got %q", body)
	}
}

type failingGets struct{ vault.Store }

func (failingGets) Get(string) ([]byte, error) { return nil, errors.New("store unavailable") }

// A secret bound to the host that keyd cannot read means it cannot scrub: the request fails closed.
func TestAnUnreadableBoundSecretFailsClosed(t *testing.T) {
	w := newWorld(t)
	var reached atomic.Bool
	w.plainUpstream("api.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached.Store(true) }))
	path := filepath.Join(t.TempDir(), "secrets.json")
	store := vault.NewMemory()
	v, err := vault.Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Put(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, []byte(echoed)); err != nil {
		t.Fatal(err)
	}
	if w.vault, err = vault.Open(failingGets{store}, path); err != nil {
		t.Fatal(err)
	}
	c := w.cell("c1", policy.Desktop)
	resp, _ := get(t, w.client(c), "http://api.example.test/")
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Keyd-Reason") != ReasonSecret || reached.Load() {
		t.Fatalf("%d %q reached=%v", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), reached.Load())
	}
}

// Revoke ends a stream at once, not when a client gives up, records it as revoked, closes pooled
// upstream connections, and the next request goes out on a fresh generation.
func TestRevokeEndsStreamsAtOnceAndServesAgain(t *testing.T) {
	w := newWorld(t)
	closed := make(chan struct{}, 8)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/once" {
			io.WriteString(rw, "once")
			return
		}
		io.WriteString(rw, "data: start\n\n")
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	srv.Config.ConnState = func(_ net.Conn, s http.ConnState) {
		if s == http.StateClosed {
			closed <- struct{}{}
		}
	}
	srv.Start()
	t.Cleanup(srv.Close)
	w.publish("stream.example.test", "80", srv.Listener.Addr().String(), true)
	c := w.cell("c1", policy.Desktop)
	if _, body := get(t, w.client(c), "http://stream.example.test/once"); body != "once" {
		t.Fatalf("%q", body)
	}
	c.Revoke()
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("a pooled upstream connection outlived Revoke")
	}
	resp, err := w.client(c).Get("http://stream.example.test/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Read(make([]byte, 16))
	start := time.Now()
	c.Revoke()
	if _, err := io.ReadAll(resp.Body); err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("the stream ended after %v with %v", time.Since(start), err)
	}
	resp.Body.Close()
	w.waitLine(reasonIs(ReasonRevoked))
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("a streaming upstream connection outlived Revoke")
	}
	if resp, body := get(t, w.client(c), "http://stream.example.test/once"); resp.StatusCode != http.StatusOK || body != "once" {
		t.Fatalf("after Revoke: %d %q", resp.StatusCode, body)
	}
}

// blockingDialer holds every dial until its context ends.
type blockingDialer struct{ entered chan struct{} }

func (d blockingDialer) DialContext(ctx context.Context, _, _ string) (net.Conn, error) {
	d.entered <- struct{}{}
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestRevokeDuringADialAnswers503(t *testing.T) {
	w := newWorld(t)
	d := blockingDialer{entered: make(chan struct{}, 1)}
	c := w.cellWith("c1", policy.Desktop, d)
	go func() {
		<-d.entered
		c.Revoke()
	}()
	resp, _ := get(t, w.client(c), "http://ports.example.test/")
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != ReasonRevoked {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}
