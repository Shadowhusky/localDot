package egress

import (
	"bufio"
	"compress/gzip"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/textproto"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/cellca"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const realValue = "real-secret-value-for-test"

func (w *world) interceptingCell(id string, role policy.Role, hosts ...string) (*Cell, *x509.Certificate) {
	w.t.Helper()
	ca, err := cellca.New(id, hosts)
	if err != nil {
		w.t.Fatal(err)
	}
	p, _ := policy.ForRole(role)
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken, CA: ca}, w.deps())
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { c.Close() })
	return c, ca.Certificate()
}

// echo answers with the request's Authorization header in the body and a header, and counts hits.
func echo(hits *atomic.Int32, seen chan<- string) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		auth := r.Header.Get("Authorization")
		if seen != nil {
			seen <- auth
		}
		rw.Header().Set("X-Echo-Auth", auth)
		json.NewEncoder(rw).Encode(map[string]string{"authorization": auth})
	})
}

func bearerSecret(w *world, id, host string) {
	w.secret(vault.Record{ID: id, Kind: vault.KindHTTP, Hosts: []string{host}, Header: "Authorization", Format: "bearer"}, realValue)
}

func do(t *testing.T, client *http.Client, method, rawURL string, header http.Header) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(method, rawURL, nil)
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, string(body)
}

func TestASurrogateIsSwappedOnItsHostAndTheEchoIsScrubbed(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	seen := make(chan string, 1)
	w.tlsUpstream("api.example.test", echo(&hits, seen))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()

	resp, body := do(t, w.client(c, caCert), "GET", "https://api.example.test/v1/forecast?city=x", http.Header{"Authorization": {"Bearer " + tok}})
	if got := <-seen; got != "Bearer "+realValue {
		t.Fatalf("upstream saw %q", got)
	}
	if resp.StatusCode != 200 || strings.Contains(body, realValue) || !strings.Contains(body, tok) || resp.Header.Get("X-Echo-Auth") != "Bearer "+tok {
		t.Fatalf("client saw %d %q %v", resp.StatusCode, body, resp.Header)
	}
	if issuer := resp.TLS.PeerCertificates[0].Issuer.CommonName; issuer != "localDot cell CA" {
		t.Fatalf("leaf issued by %q", issuer)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "mitm" && l.Kind == audit.KindRequest })
	if !l.Swapped || l.SecretID != "weather" || l.SurrogateID != surrogate.ID(tok) || l.Decision != audit.Allow || l.Path != "/v1/forecast" {
		t.Fatalf("audit %+v", l)
	}
	e := <-sub
	if ku := e.Data.(events.KeyUse); ku.SecretID != "weather" || ku.Decision != "allow" || ku.Host != "api.example.test" {
		t.Fatalf("event %+v", e)
	}
}

func TestReflectionsInEveryFormAreScrubbed(t *testing.T) {
	forms := map[string]http.HandlerFunc{
		"plain body": func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "token="+realValue) },
		"encoded body": func(rw http.ResponseWriter, _ *http.Request) {
			io.WriteString(rw, base64.StdEncoding.EncodeToString([]byte("user:"+realValue))+" "+hex.EncodeToString([]byte(realValue))+" "+url.QueryEscape(realValue))
		},
		"split across writes": func(rw http.ResponseWriter, _ *http.Request) {
			for i := range len(realValue) {
				io.WriteString(rw, realValue[i:i+1])
				rw.(http.Flusher).Flush()
			}
		},
		"gzip body": func(rw http.ResponseWriter, r *http.Request) {
			if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
				http.Error(rw, "gzip was not requested", 500)
				return
			}
			rw.Header().Set("Content-Encoding", "gzip")
			zw := gzip.NewWriter(rw)
			for range 200 {
				io.WriteString(zw, "padding "+realValue+" ")
			}
			zw.Close()
		},
		"redirect location": func(rw http.ResponseWriter, r *http.Request) {
			http.Redirect(rw, r, "https://cdn.example.test/f?key="+url.QueryEscape(realValue), http.StatusFound)
		},
		"set-cookie": func(rw http.ResponseWriter, _ *http.Request) {
			rw.Header().Set("Set-Cookie", "k="+realValue+"; Path=/")
		},
		"trailer": func(rw http.ResponseWriter, _ *http.Request) {
			rw.Header().Set("Trailer", "X-Echo")
			io.WriteString(rw, "body")
			rw.Header().Set("X-Echo", realValue)
		},
	}
	for name, handler := range forms {
		t.Run(name, func(t *testing.T) {
			w := newWorld(t)
			w.tlsUpstream("api.example.test", handler)
			bearerSecret(w, "weather", "api.example.test")
			c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
			tok := w.mint("c1", "weather")
			resp, body := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
			everything := body + resp.Header.Get("Location") + resp.Header.Get("Set-Cookie") + resp.Trailer.Get("X-Echo")
			for _, form := range []string{realValue, hex.EncodeToString([]byte(realValue)), url.QueryEscape(realValue), base64.StdEncoding.EncodeToString([]byte("user:" + realValue))} {
				if strings.Contains(everything, form) {
					t.Fatalf("the client saw %q in %q", form, everything)
				}
			}
			if name == "gzip body" && (!strings.Contains(body, "padding "+tok) || resp.Header.Get("Content-Encoding") != "") {
				t.Fatalf("gzip: %d bytes, encoding %q", len(body), resp.Header.Get("Content-Encoding"))
			}
		})
	}
}

func TestInformationalResponseHeadersAreScrubbed(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("api.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Link", "<https://cdn.example.test/app.js?k="+realValue+">; rel=preload")
		rw.WriteHeader(http.StatusEarlyHints)
		rw.Header().Del("Link")
		io.WriteString(rw, "ok")
	}))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	var hints []string
	trace := &httptrace.ClientTrace{Got1xxResponse: func(code int, h textproto.MIMEHeader) error {
		hints = append(hints, h.Get("Link"))
		return nil
	}}
	req, _ := http.NewRequestWithContext(httptrace.WithClientTrace(context.Background(), trace), "GET", "https://api.example.test/", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := w.client(c, caCert).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if len(hints) != 1 || strings.Contains(hints[0], realValue) || !strings.Contains(hints[0], tok) {
		t.Fatalf("early hints %q", hints)
	}
}

func TestBrowsingABoundHostWithoutTheSurrogateIsUntouched(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	seen := make(chan string, 1)
	w.tlsUpstream("api.example.test", echo(&hits, seen))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/docs", nil)
	if resp.StatusCode != 200 || <-seen != "" {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestMisplacedAndUnknownSurrogatesNeverReachTheUpstream(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	foreign := w.mint("c2", "weather")
	unknown, _ := surrogate.Mint("key")
	cases := []struct {
		name   string
		url    string
		header http.Header
		reason string
	}{
		{"unknown surrogate", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + unknown}}, "unknown-surrogate"},
		{"another cell's surrogate", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + foreign}}, "misplaced-surrogate"},
		{"wrong header", "https://api.example.test/", http.Header{"X-Api-Key": {tok}}, "misplaced-surrogate"},
		{"substring", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok + "x y"}}, "misplaced-surrogate"},
		{"in the query", "https://api.example.test/?key=" + tok, nil, "misplaced-surrogate"},
	}
	for _, cs := range cases {
		resp, _ := do(t, w.client(c, caCert), "GET", cs.url, cs.header)
		if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != cs.reason {
			t.Errorf("%s: %d %q", cs.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the upstream was reached %d times", n)
	}
}

func TestPathAndMethodLimitsHoldOnTheWire(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	w.secret(vault.Record{ID: "ro", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{"/v1/"}}, realValue)
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "ro")
	bearer := http.Header{"Authorization": {"Bearer " + tok}}
	// Real servers read each of these paths as /admin, or as a method other than GET.
	for _, u := range []string{
		"https://api.example.test/v1/../admin",
		"https://api.example.test/v1/%2e%2e/admin",
		"https://api.example.test/v1%2f..%2fadmin",
		"https://api.example.test/v1/%2E%2E/admin",
		"https://api.example.test/v1//admin",
		"https://api.example.test/v1/..;/admin",
		"https://api.example.test/v1/x?_method=DELETE",
	} {
		if resp, _ := do(t, w.client(c, caCert), "GET", u, bearer); resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != "surrogate-policy" {
			t.Errorf("%s: %d %q", u, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
	}
	override := http.Header{"Authorization": {"Bearer " + tok}, "X-Http-Method-Override": {"DELETE"}}
	if resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/v1/x", override); resp.StatusCode != 403 {
		t.Errorf("method override: %d", resp.StatusCode)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the upstream got the real key %d times", n)
	}
	if resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/v1/forecast", bearer); resp.StatusCode != 200 || hits.Load() != 1 {
		t.Fatalf("a path inside the limit: %d", resp.StatusCode)
	}
}

func TestSwapsStopWhileTheAuditLogCannotBeWritten(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	w.audit.Close()
	do(t, w.client(c, caCert), "GET", "http://keyd.ldot/health", nil)
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != "audit-unavailable" || hits.Load() != 0 {
		t.Fatalf("%d %q, upstream reached %d times", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
}

func dialIntercepted(t *testing.T, w *world, c *Cell, caCert *x509.Certificate, sni string) (*tls.Conn, error) {
	t.Helper()
	conn, resp := rawConnect(t, c, "api.example.test:443")
	if resp.StatusCode != 200 {
		t.Fatalf("CONNECT: %d", resp.StatusCode)
	}
	roots := x509.NewCertPool()
	roots.AddCert(caCert)
	tc := tls.Client(conn, &tls.Config{ServerName: sni, RootCAs: roots})
	tc.SetDeadline(time.Now().Add(3 * time.Second))
	return tc, tc.Handshake()
}

func TestTheInnerHostMustMatchTheTunnel(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	w.tlsUpstream("evil.example.test", echo(&hits, nil))
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	for _, request := range []string{
		"GET / HTTP/1.1\r\nHost: evil.example.test\r\n\r\n",
		"GET https://evil.example.test/ HTTP/1.1\r\nHost: api.example.test\r\n\r\n",
		"GET http://api.example.test/ HTTP/1.1\r\nHost: api.example.test\r\n\r\n",
		"GET / HTTP/1.1\r\nHost: api.example.test:8443\r\n\r\n",
	} {
		tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(tc, request)
		resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusMisdirectedRequest || resp.Header.Get("X-Keyd-Reason") != ReasonHostMismatch {
			t.Errorf("%q: %d", request, resp.StatusCode)
		}
	}
	if hits.Load() != 0 {
		t.Fatal("an upstream was reached")
	}
}

func TestASurrogateInTheHostHeaderIsRefusedAndAlerted(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	io.WriteString(tc, "GET / HTTP/1.1\r\nHost: "+tok+".api.example.test\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != "misplaced-surrogate" || hits.Load() != 0 {
		t.Fatalf("%d %q, upstream reached %d times", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
	select {
	case e := <-sub:
		if ku, ok := e.Data.(events.KeyUse); !ok || ku.SecretID != "weather" || ku.Decision != "deny" || strings.Contains(ku.Host+ku.Path, tok) {
			t.Fatalf("event %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no key.use alert")
	}
}

func TestAnInterceptedHandshakeChecksSNIAndRecordsAborts(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("api.example.test", echo(new(atomic.Int32), nil))
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	if _, err := dialIntercepted(t, w, c, caCert, "evil.example.test"); err == nil {
		t.Fatal("handshake with a mismatched SNI succeeded")
	}
	l := w.waitLine(reasonIs(ReasonSNIMismatch))
	if l.Mode != "mitm" || l.SNI != "evil.example.test" {
		t.Fatalf("audit %+v", l)
	}
	// A client that does not trust the cell CA aborts the handshake; keyd records it.
	if _, err := w.client(c).Get("https://api.example.test/"); err == nil {
		t.Fatal("a client without the cell CA completed the handshake")
	}
	w.waitLine(func(l audit.Line) bool {
		return l.Reason == ReasonHandshake && strings.Contains(l.Detail, "certificate")
	})
}

func TestTheSecretOnlyLeavesOverVerifiedTLS(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	ca, _ := cellca.New("c1", []string{"api.example.test"})
	p, _ := policy.ForRole(policy.Desktop)
	deps := w.deps()
	deps.RootCAs = x509.NewCertPool()
	c, err := Open(Config{CellID: "c1", Policy: p, Token: testToken, CA: ca}, deps)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	tok := w.mint("c1", "weather")
	resp, _ := do(t, w.client(c, ca.Certificate()), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonUpstreamTLS || hits.Load() != 0 {
		t.Fatalf("%d %q hits %d", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
}

func TestABoundHostResolvingToAPrivateAddressIsRefused(t *testing.T) {
	w := newWorld(t)
	w.name("api.example.test", "127.0.0.1")
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonAddress {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestUpgradesAreRefusedOnInterceptedHosts(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/ws", http.Header{"Connection": {"Upgrade"}, "Upgrade": {"websocket"}})
	if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonUpgrade || hits.Load() != 0 {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestBasicAuthIsSwappedInsideTheEncoding(t *testing.T) {
	w := newWorld(t)
	seen := make(chan string, 1)
	w.tlsUpstream("git.example.test", echo(new(atomic.Int32), seen))
	w.secret(vault.Record{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"git.example.test"}, Header: "Authorization", Format: "basic-password"}, realValue)
	c, caCert := w.interceptingCell("c1", policy.Desktop, "git.example.test")
	tok := w.mint("c1", "git")
	header := http.Header{"Authorization": {"Basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:"+tok))}}
	resp, body := do(t, w.client(c, caCert), "GET", "https://git.example.test/repo.git/info/refs", header)
	if got := <-seen; got != "Basic "+base64.StdEncoding.EncodeToString([]byte("x-access-token:"+realValue)) {
		t.Fatalf("upstream saw %q", got)
	}
	decoded, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(resp.Header.Get("X-Echo-Auth"), "Basic "))
	if resp.StatusCode != 200 || strings.Contains(string(decoded), realValue) || strings.Contains(body, base64.StdEncoding.EncodeToString([]byte("x-access-token:"+realValue))) {
		t.Fatalf("the reflected basic credential still carries the secret: %q / %q", decoded, body)
	}
}

func TestAnUnscrubbableEncodingIsRefused(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("api.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Encoding", "br")
		rw.Write([]byte{0x1b, 0x00})
	}))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	resp, _ := do(t, w.client(c, caCert), "GET", "https://api.example.test/", http.Header{"Authorization": {"Bearer " + tok}})
	if resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonEncoding {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

// The inner TLS server has the same request-size boundary as the public listener. A
// long header must be refused before Registry.Inspect or an upstream sees its shapes.
func TestInterceptedRequestsKeepTheHeaderSizeBoundary(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	defer tc.Close()
	request := "GET / HTTP/1.1\r\nHost: api.example.test\r\nX-Padding: " + strings.Repeat("x", 128<<10) + "\r\n\r\n"
	if _, err := io.WriteString(tc, request); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestHeaderFieldsTooLarge {
		t.Fatalf("oversized inner request: status %d, want 431", resp.StatusCode)
	}
	if hits.Load() != 0 {
		t.Fatal("oversized inner request reached the upstream")
	}
}

func TestInnerAuthorityUsesASCIICanonicalHostAndHTTPSPort(t *testing.T) {
	for _, tc := range []struct {
		authority, host string
		want            bool
	}{
		{"API.EXAMPLE.TEST.", "api.example.test", true},
		{"api.example.test:443", "api.example.test", true},
		{"api.example.test:8443", "api.example.test", false},
		{"api.example.test:", "api.example.test", false},
		{"api.example.test..", "api.example.test", false},
		{"api.example.test@evil.test", "api.example.test", false},
		{"api.example.test.evil.test", "api.example.test", false},
		{"key.example.test", "key.example.test", true},
		{"Key.example.test", "key.example.test", false},
	} {
		if got := hostIs(tc.authority, tc.host); got != tc.want {
			t.Errorf("hostIs(%q, %q) = %v, want %v", tc.authority, tc.host, got, tc.want)
		}
	}
}

func TestInnerOptionsStarStillInspectsAndAuditsTheRequest(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}}, realValue)
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	defer tc.Close()
	io.WriteString(tc, "OPTIONS * HTTP/1.1\r\nHost: api.example.test\r\nAuthorization: Bearer "+tok+"\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != keys.ReasonSurrogatePolicy {
		t.Fatalf("OPTIONS * bypassed inspection: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if hits.Load() != 0 {
		t.Fatal("OPTIONS * reached the upstream")
	}
	w.waitLine(func(line audit.Line) bool {
		return line.Mode == "mitm" && line.Method == "OPTIONS" && line.Decision == audit.Deny
	})
}

func TestAnAbsoluteInnerTargetSurrogateIsRefusedAndAlerted(t *testing.T) {
	w := newWorld(t)
	var hits atomic.Int32
	w.tlsUpstream("api.example.test", echo(&hits, nil))
	bearerSecret(w, "weather", "api.example.test")
	c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
	tok := w.mint("c1", "weather")
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	defer tc.Close()
	io.WriteString(tc, "GET https://"+tok+".api.example.test/ HTTP/1.1\r\nHost: api.example.test\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != keys.ReasonMisplacedSurrogate {
		t.Fatalf("absolute-target surrogate: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if hits.Load() != 0 {
		t.Fatal("absolute-target surrogate reached the upstream")
	}
	select {
	case e := <-sub:
		if ku, ok := e.Data.(events.KeyUse); !ok || ku.SecretID != "weather" || ku.Decision != "deny" || strings.Contains(ku.Host+ku.Path, tok) {
			t.Fatalf("alert %+v", e)
		}
	case <-time.After(time.Second):
		t.Fatal("no key.use alert")
	}
}

// A completed TLS tunnel can wait indefinitely for its first HTTP request. Closing
// the generation must reach that raw connection as well as active request contexts.
func TestRevokeAndCloseEndIdleInterceptedTunnels(t *testing.T) {
	for _, action := range []string{"revoke", "close"} {
		t.Run(action, func(t *testing.T) {
			w := newWorld(t)
			c, caCert := w.interceptingCell("c1", policy.Desktop, "api.example.test")
			tc, err := dialIntercepted(t, w, c, caCert, "api.example.test")
			if err != nil {
				t.Fatal(err)
			}
			defer tc.Close()
			w.waitLine(func(line audit.Line) bool {
				return line.Mode == "mitm" && line.Kind == audit.KindConnect && line.Decision == audit.Allow
			})
			if action == "revoke" {
				c.Revoke()
			} else if err := c.Close(); err != nil {
				t.Fatal(err)
			}
			tc.SetReadDeadline(time.Now().Add(time.Second))
			var one [1]byte
			if n, err := tc.Read(one[:]); n != 0 || err != io.EOF {
				t.Fatalf("idle intercepted tunnel after %s: n=%d error=%v, want EOF", action, n, err)
			}
		})
	}
}
