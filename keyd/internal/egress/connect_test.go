package egress

import (
	"crypto/tls"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

func TestPassthroughKeepsTheUpstreamCertificate(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "tls-ok") }))
	c := w.cell("c1", policy.Desktop)
	resp, err := w.client(c).Get("https://www.example.test/page")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(body) != "tls-ok" || resp.TLS.PeerCertificates[0].Issuer.CommonName != "upstream test CA" {
		t.Fatalf("body %q issuer %q", body, resp.TLS.PeerCertificates[0].Issuer.CommonName)
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "passthrough" && l.Decision == audit.Allow })
	if l.Host != "www.example.test" || l.SNI != "www.example.test" || l.BytesIn == 0 || l.BytesOut == 0 {
		t.Fatalf("audit %+v", l)
	}
}

func TestConnectPolicy(t *testing.T) {
	w := newWorld(t)
	desktop := w.cell("c1", policy.Desktop)
	brain := w.cell("c2", policy.Brain)
	cases := []struct {
		name      string
		cell      *Cell
		authority string
		reason    string
	}{
		{"loopback address", desktop, "127.0.0.1:443", ReasonAddress},
		{"ipv6 loopback", desktop, "[::1]:443", ReasonAddress},
		{"mapped loopback", desktop, "[::ffff:127.0.0.1]:443", ReasonAddress},
		{"metadata address", desktop, "169.254.169.254:80", ReasonAddress},
		{"private address", desktop, "192.168.1.20:8080", ReasonAddress},
		{"zoned address", desktop, "[fe80::1%25eth0]:443", policy.ReasonHostInvalid},
		{"smtp", desktop, "mail.example.test:25", policy.ReasonSMTP},
		{"another port resolves before asking", desktop, "missing.example.test:8443", ReasonResolve},
		{"port required", desktop, "www.example.test", policy.ReasonHostInvalid},
		{"deny list", desktop, "nas.home.arpa:443", policy.ReasonHostDenied},
		{"the gateway is plain http only", desktop, "llm.ldot:443", policy.ReasonHostDenied},
		{"brain has no web", brain, "www.example.test:443", policy.ReasonNoWeb},
	}
	for _, c := range cases {
		_, resp := rawConnect(t, c.cell, c.authority)
		if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != c.reason {
			t.Errorf("%s: %d %q, want 403 %q", c.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), c.reason)
		}
	}
}

func TestASurrogateOnTheConnectItselfIsRefused(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	conn, err := dialListener(c)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "CONNECT www.example.test:443 HTTP/1.1\r\nHost: www.example.test:443\r\nProxy-Authorization: Basic "+
		basicAuth("cell", testToken)+"\r\nAuthorization: Bearer ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA\r\n\r\n")
	line, _ := io.ReadAll(io.LimitReader(conn, 12))
	if string(line) != "HTTP/1.1 403" {
		t.Fatalf("got %q", line)
	}
	w.waitLine(func(l audit.Line) bool { return l.Kind == audit.KindConnect && l.Reason == "unknown-surrogate" })
}

func TestSNIMustMatchTheConnectHost(t *testing.T) {
	w := newWorld(t)
	reached := make(chan struct{}, 1)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached <- struct{}{} }))
	c := w.cell("c1", policy.Desktop)
	for _, sni := range []string{"other.example.test", ""} {
		conn, resp := rawConnect(t, c, "www.example.test:443")
		if resp.StatusCode != 200 {
			t.Fatalf("CONNECT: %d", resp.StatusCode)
		}
		cfg := &tls.Config{ServerName: sni, InsecureSkipVerify: true}
		tc := tls.Client(conn, cfg)
		tc.SetDeadline(time.Now().Add(3 * time.Second))
		if err := tc.Handshake(); err == nil {
			t.Fatalf("SNI %q: handshake succeeded", sni)
		}
	}
	select {
	case <-reached:
		t.Fatal("the upstream was reached")
	default:
	}
	l := w.waitLine(reasonIs(ReasonSNIMismatch))
	if l.Host != "www.example.test" || l.Decision != audit.Deny {
		t.Fatalf("audit %+v", l)
	}
}

func TestATunnelMustCarryTLS(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	c := w.cell("c1", policy.Desktop)
	conn, _ := rawConnect(t, c, "www.example.test:443")
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: api.example.test\r\n\r\n")
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if n, _ := conn.Read(make([]byte, 1)); n != 0 {
		t.Fatal("plain HTTP inside a tunnel got an answer")
	}
	w.waitLine(reasonIs(ReasonNotTLS))
}

func TestAPassthroughToAPrivateAddressIsRefusedAtDial(t *testing.T) {
	w := newWorld(t)
	w.name("rebind.example.test", "192.168.65.254")
	c := w.cell("c1", policy.Desktop)
	conn, resp := rawConnect(t, c, "rebind.example.test:443")
	if resp.StatusCode != 200 {
		t.Fatalf("CONNECT: %d", resp.StatusCode)
	}
	tc := tls.Client(conn, &tls.Config{ServerName: "rebind.example.test", InsecureSkipVerify: true})
	tc.SetDeadline(time.Now().Add(3 * time.Second))
	if err := tc.Handshake(); err == nil {
		t.Fatal("handshake through a denied address")
	}
	l := w.waitLine(reasonIs(ReasonAddress))
	if l.Decision != audit.Deny || !strings.Contains(l.Detail, "docker desktop") {
		t.Fatalf("audit %+v", l)
	}
}

func TestKeydNeverDialsThroughAnotherProxy(t *testing.T) {
	for _, name := range []string{"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy"} {
		t.Setenv(name, "http://127.0.0.1:9")
	}
	w := newWorld(t)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "direct") }))
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "direct") }))
	c := w.cell("c1", policy.Desktop)
	for _, u := range []string{"http://ports.example.test/", "https://www.example.test/"} {
		if resp, body := get(t, w.client(c), u); resp.StatusCode != 200 || body != "direct" {
			t.Fatalf("%s: %d %q", u, resp.StatusCode, body)
		}
	}
}
