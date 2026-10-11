package egress

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// kelvin is U+212A, which strings.EqualFold folds to an ASCII k.
const kelvin = string(rune(0x212A))

// handshakeThrough opens a tunnel to authority and runs a TLS handshake naming sni in it.
func handshakeThrough(t *testing.T, c *Cell, authority, sni string) error {
	t.Helper()
	conn, resp := rawConnect(t, c, authority)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT %s: %d", authority, resp.StatusCode)
	}
	tc := tls.Client(conn, &tls.Config{ServerName: sni, InsecureSkipVerify: true})
	tc.SetDeadline(time.Now().Add(3 * time.Second))
	defer tc.Close()
	return tc.Handshake()
}

// The SNI is compared in ASCII only: a ClientHello naming the host with a Unicode letter that folds
// to an ASCII one is another name, and never reaches the upstream.
func TestTheSNIIsComparedInASCIIOnly(t *testing.T) {
	if sameHost(kelvin+"elvin.example.test", "kelvin.example.test") || sameHost("kelvin.example.test"+kelvin, "kelvin.example.test") {
		t.Fatal("a Unicode fold matched")
	}
	for _, sni := range []string{"kelvin.example.test", "KELVIN.Example.TEST", "kelvin.example.test."} {
		if !sameHost(sni, "kelvin.example.test") {
			t.Fatalf("%q did not match", sni)
		}
	}
	w := newWorld(t)
	reached := make(chan struct{}, 4)
	w.tlsUpstream("kelvin.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { reached <- struct{}{} }))
	c, rd := w.recordingCell("c1", policy.Desktop)
	if err := handshakeThrough(t, c, "kelvin.example.test:443", kelvin+"elvin.example.test"); err == nil {
		t.Fatal("a Kelvin SNI completed a handshake")
	}
	l := w.waitLine(reasonIs(ReasonSNIMismatch))
	if l.Decision != audit.Deny || l.Host != "kelvin.example.test" {
		t.Fatalf("audit %+v", l)
	}
	if a := rd.addresses(); len(a) != 0 {
		t.Fatalf("dialled %v", a)
	}
	if err := handshakeThrough(t, c, "kelvin.example.test:443", "KELVIN.example.test"); err != nil {
		t.Fatalf("an upper-case ASCII SNI: %v", err)
	}
}

// A passthrough dials the absolute name, as plain HTTP does, so the resolver's search domains never
// apply; the ClientHello, and its SNI, reach the upstream as the client sent them.
func TestAPassthroughDialsTheAbsoluteName(t *testing.T) {
	w := newWorld(t)
	seen := make(chan string, 4)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.TLS.ServerName
		io.WriteString(rw, "ok")
	}))
	c, rd := w.recordingCell("c1", policy.Desktop)
	for _, u := range []string{"https://www.example.test/", "https://WWW.Example.test:443/"} {
		resp, body := get(t, w.client(c), u)
		if resp.StatusCode != 200 || body != "ok" {
			t.Fatalf("%s: %d %q", u, resp.StatusCode, body)
		}
		if sni := <-seen; !strings.EqualFold(sni, "www.example.test") {
			t.Fatalf("%s: upstream saw SNI %q", u, sni)
		}
	}
	a := rd.addresses()
	if len(a) != 2 || a[0] != "www.example.test.:443" || a[1] != "www.example.test.:443" {
		t.Fatalf("dialled %q, want the absolute name twice", a)
	}
}

// crlf ends HTTP lines in these tests; every other control byte is built from its value.
const crlf = "\r\n"

// tokenLine is the cell's credential as one header line, without its line end.
func tokenLine() string { return "Proxy-Authorization: Basic " + basicAuth("cell", testToken) }

// connectLine is a CONNECT to authority carrying the cell's token and the extra header lines.
func connectLine(authority string, headers ...string) string {
	req := "CONNECT " + authority + " HTTP/1.1" + crlf + "Host: " + authority + crlf
	for _, h := range headers {
		req += h + crlf
	}
	return req + crlf
}

// serverName is one entry of a ClientHello's server_name list; kind 0 is host_name.
type serverName struct {
	kind byte
	name string
}

func be16(n int) []byte { return []byte{byte(n >> 8), byte(n)} }

// clientHello builds a minimal ClientHello handshake message with the given server_name entries
// (no extension when names is nil), the extension twice when twice is set, and extra extensions.
func clientHello(names []serverName, twice bool, extra []byte) []byte {
	var exts []byte
	if names != nil {
		var list []byte
		for _, n := range names {
			list = append(append(append(list, n.kind), be16(len(n.name))...), n.name...)
		}
		body := append(be16(len(list)), list...)
		ext := append(append([]byte{0, 0}, be16(len(body))...), body...)
		exts = append(exts, ext...)
		if twice {
			exts = append(exts, ext...)
		}
	}
	exts = append(exts, extra...)
	b := append([]byte{3, 3}, make([]byte, 32)...)
	b = append(b, 0)
	b = append(append(b, be16(2)...), 0xc0, 0x2f)
	b = append(b, 1, 0)
	b = append(append(b, be16(len(exts))...), exts...)
	return append([]byte{1, byte(len(b) >> 16), byte(len(b) >> 8), byte(len(b))}, b...)
}

// padding is a padding extension (21) of n zero bytes.
func padding(n int) []byte {
	return append(append([]byte{0, 21}, be16(n)...), make([]byte, n)...)
}

// handshakeRecords splits a handshake message into TLS records of at most size bytes.
func handshakeRecords(msg []byte, size int) []byte {
	var out []byte
	for len(msg) > 0 {
		n := min(size, len(msg))
		out = append(append(append(out, 0x16, 3, 1), be16(n)...), msg[:n]...)
		msg = msg[n:]
	}
	return out
}

// byteSink is a raw TCP upstream on host:443 that keeps every byte it receives.
type byteSink struct {
	mu    sync.Mutex
	got   bytes.Buffer
	conns int
}

func (w *world) byteSink(host string) *byteSink {
	w.t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { ln.Close() })
	s := &byteSink{}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			s.mu.Lock()
			s.conns++
			s.mu.Unlock()
			go func() {
				defer conn.Close()
				conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				buf := make([]byte, 4096)
				for {
					n, err := conn.Read(buf)
					s.mu.Lock()
					s.got.Write(buf[:n])
					s.mu.Unlock()
					if err != nil {
						return
					}
				}
			}()
		}
	}()
	w.publish(host, "443", ln.Addr().String(), true)
	return s
}

func (s *byteSink) received() ([]byte, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]byte(nil), s.got.Bytes()...), s.conns
}

// await waits until the sink holds want, or fails with what it holds.
func (s *byteSink) await(t *testing.T, want []byte) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		got, _ := s.received()
		if bytes.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("upstream got %d bytes %x, want %d bytes %x", len(got), got, len(want), want)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// sendThrough opens a tunnel to authority, writes payload into it and closes it once keyd has had
// time to read it.
func sendThrough(t *testing.T, c *Cell, authority string, payload []byte) {
	t.Helper()
	conn, resp := rawConnect(t, c, authority)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT %s: %d", authority, resp.StatusCode)
	}
	conn.Write(payload)
	time.Sleep(200 * time.Millisecond)
	conn.Close()
}

func connectLine1(w *world) audit.Line {
	return w.waitLine(func(l audit.Line) bool { return l.Kind == audit.KindConnect })
}

// Only a ClientHello whose one host_name is the CONNECT host opens a passthrough: an address, a
// longer or embedded name, a wildcard, a name of another kind, none at all, or a list crypto/tls
// refuses never causes a dial.
func TestOnlyTheConnectHostAsTheServerNameOpensAPassthrough(t *testing.T) {
	nul := string(rune(0))
	for _, tc := range []struct {
		name   string
		names  []serverName
		twice  bool
		reason string
	}{
		{"an address", []serverName{{0, "127.0.0.1"}}, false, ReasonSNIMismatch},
		{"a NUL then more", []serverName{{0, "www.example.test" + nul + ".evil.test"}}, false, ReasonSNIMismatch},
		{"a longer name", []serverName{{0, "www.example.test.evil.test"}}, false, ReasonSNIMismatch},
		{"a parent", []serverName{{0, "example.test"}}, false, ReasonSNIMismatch},
		{"a wildcard", []serverName{{0, "*.example.test"}}, false, ReasonSNIMismatch},
		{"another kind only", []serverName{{1, "www.example.test"}}, false, ReasonSNIMismatch},
		{"no extension", nil, false, ReasonSNIMismatch},
		{"a trailing dot", []serverName{{0, "www.example.test."}}, false, ReasonNotTLS},
		{"two host names", []serverName{{0, "www.example.test"}, {0, "evil.test"}}, false, ReasonNotTLS},
		{"the extension twice", []serverName{{0, "www.example.test"}}, true, ReasonNotTLS},
	} {
		w := newWorld(t)
		sink := w.byteSink("www.example.test")
		c, rd := w.recordingCell("c1", policy.Desktop)
		sendThrough(t, c, "www.example.test:443", handshakeRecords(clientHello(tc.names, tc.twice, nil), 1<<14))
		l := connectLine1(w)
		if l.Decision != audit.Deny || l.Reason != tc.reason || l.Mode != "passthrough" || l.Host != "www.example.test" {
			t.Errorf("%s: audit %+v, want deny %q", tc.name, l, tc.reason)
		}
		if a := rd.addresses(); len(a) != 0 {
			t.Errorf("%s: dialled %v", tc.name, a)
		}
		if _, conns := sink.received(); conns != 0 {
			t.Errorf("%s: the upstream was reached", tc.name)
		}
	}
}

// What the client sends reaches the upstream byte for byte, however its ClientHello is split into
// records and whatever follows it in the same write, and the audit line counts all of it.
func TestAPassthroughRelaysTheClientsBytesExactly(t *testing.T) {
	appData := append([]byte{0x17, 3, 3}, be16(5)...)
	appData = append(appData, "early"...)
	for _, size := range []int{1, 5, 1 << 14} {
		for _, sni := range []string{"www.example.test", "WWW.Example.TEST"} {
			w := newWorld(t)
			sink := w.byteSink("www.example.test")
			c := w.cell("c1", policy.Desktop)
			payload := handshakeRecords(clientHello([]serverName{{0, sni}}, false, nil), size)
			payload = append(append(payload, appData...), "and more"...)
			sendThrough(t, c, "www.example.test:443", payload)
			sink.await(t, payload)
			l := w.waitLine(func(l audit.Line) bool { return l.Mode == "passthrough" })
			if l.Decision != audit.Allow || l.Reason != "" || l.Status != http.StatusOK || l.SNI != sni || l.BytesIn != int64(len(payload)) {
				t.Fatalf("records of %d, SNI %q: audit %+v, want %d bytes in", size, sni, l, len(payload))
			}
			// A refused ClientHello split the same way is refused.
			w2 := newWorld(t)
			sink2 := w2.byteSink("www.example.test")
			c2 := w2.cell("c1", policy.Desktop)
			sendThrough(t, c2, "www.example.test:443", handshakeRecords(clientHello([]serverName{{0, "other.example.test"}}, false, nil), size))
			if l := connectLine1(w2); l.Reason != ReasonSNIMismatch {
				t.Fatalf("records of %d: audit %+v", size, l)
			}
			if _, conns := sink2.received(); conns != 0 {
				t.Fatalf("records of %d: a mismatched hello reached the upstream", size)
			}
		}
	}
}

// keyd reads at most 16 KiB looking for the ClientHello; a longer one is refused before any dial.
func TestAClientHelloOver16KiBIsRefused(t *testing.T) {
	for _, tc := range []struct {
		pad   int
		allow bool
	}{{15000, true}, {20000, false}} {
		w := newWorld(t)
		sink := w.byteSink("www.example.test")
		c := w.cell("c1", policy.Desktop)
		sendThrough(t, c, "www.example.test:443", handshakeRecords(clientHello([]serverName{{0, "www.example.test"}}, false, padding(tc.pad)), 1<<14))
		l := connectLine1(w)
		_, conns := sink.received()
		if tc.allow && (l.Decision != audit.Allow || conns != 1) {
			t.Fatalf("%d bytes of padding: audit %+v, %d upstream connections", tc.pad, l, conns)
		}
		if !tc.allow && (l.Reason != ReasonNotTLS || conns != 0) {
			t.Fatalf("%d bytes of padding: audit %+v, %d upstream connections", tc.pad, l, conns)
		}
	}
}

// A tunnel opens only with a TLS ClientHello: HTTP/2's preface, a second CONNECT, an SSLv2-style
// hello or an empty handshake record get nothing, and nothing is dialled.
func TestOnlyAClientHelloOpensATunnel(t *testing.T) {
	for _, payload := range [][]byte{
		[]byte("PRI * HTTP/2.0" + crlf + crlf + "SM" + crlf + crlf),
		[]byte(connectLine("www.example.test:443", tokenLine())),
		{0x80, 0x2e, 0x01, 0x03, 0x01},
		{0x16, 0x03, 0x01, 0x00, 0x00},
	} {
		w := newWorld(t)
		sink := w.byteSink("www.example.test")
		c, rd := w.recordingCell("c1", policy.Desktop)
		sendThrough(t, c, "www.example.test:443", payload)
		if l := connectLine1(w); l.Decision != audit.Deny || l.Reason != ReasonNotTLS {
			t.Errorf("%q: audit %+v", payload, l)
		}
		if _, conns := sink.received(); conns != 0 || len(rd.addresses()) != 0 {
			t.Errorf("%q: dialled %v", payload, rd.addresses())
		}
	}
}

// Revoke ends an open passthrough tunnel at once and audits it as revoked; the cell then tunnels
// again, and Close ends a tunnel too.
func TestRevokeAndCloseEndPassthroughTunnels(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "ok") }))
	c := w.cell("c1", policy.Desktop)
	open := func() *tls.Conn {
		conn, resp := rawConnect(t, c, "www.example.test:443")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("CONNECT: %d", resp.StatusCode)
		}
		tc := tls.Client(conn, &tls.Config{ServerName: "www.example.test", RootCAs: w.roots()})
		if err := tc.Handshake(); err != nil {
			t.Fatal(err)
		}
		return tc
	}
	ended := func(tc *tls.Conn, what string) {
		start := time.Now()
		tc.SetReadDeadline(time.Now().Add(5 * time.Second))
		if _, err := tc.Read(make([]byte, 1)); err == nil || time.Since(start) > 2*time.Second {
			t.Fatalf("after %s: read %v after %v", what, err, time.Since(start))
		}
	}
	tc := open()
	c.Revoke()
	ended(tc, "Revoke")
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "passthrough" })
	if l.Decision != audit.Error || l.Reason != ReasonRevoked || l.Host != "www.example.test" {
		t.Fatalf("audit %+v", l)
	}
	if resp, body := get(t, w.client(c), "https://www.example.test/"); resp.StatusCode != 200 || body != "ok" {
		t.Fatalf("after Revoke: %d %q", resp.StatusCode, body)
	}
	// A tunnel still waiting for its ClientHello is the cell's too.
	conn, resp := rawConnect(t, c, "www.example.test:443")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT: %d", resp.StatusCode)
	}
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	c.Revoke()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := conn.Read(make([]byte, 1)); err == nil || time.Since(start) > 2*time.Second {
		t.Fatalf("a tunnel awaiting its ClientHello: read %v after %v", err, time.Since(start))
	}
	tc = open()
	c.Close()
	ended(tc, "Close")
}

// A CONNECT is inspected before its authority is checked: a surrogate in the authority or a header,
// known or not, valid host or not, is refused under its own reason and alerted, with nothing dialled
// and no surrogate in the audit.
func TestASurrogateOnAConnectIsRefusedAndAlerted(t *testing.T) {
	w := newWorld(t)
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, echoed)
	sink := w.byteSink("api.example.test")
	c, rd := w.recordingCell("c1", policy.Desktop)
	known := w.mint("c1", "weather")
	unknown, _ := surrogate.Mint("key")
	sub, cancel := w.events.Subscribe(64)
	defer cancel()
	refusals := 0
	for _, tc := range []struct {
		tok, reason, secret string
	}{{known, keys.ReasonMisplacedSurrogate, "weather"}, {unknown, keys.ReasonUnknownSurrogate, "unknown"}} {
		requests := []string{
			connectLine(tc.tok+".example.test:443", tokenLine()),
			connectLine(tc.tok+":443", tokenLine()),
			connectLine("x."+tc.tok+".local:8443", tokenLine()),
		}
		for _, h := range []string{"Authorization: Bearer " + tc.tok, "X-Note: " + tc.tok, "Cookie: a=" + tc.tok} {
			requests = append(requests, connectLine("api.example.test:443", h, tokenLine()))
		}
		for _, req := range requests {
			resp, _ := rawRequest(t, c, req)
			if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != tc.reason {
				t.Errorf("%q: %d %q, want 403 %q", req, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), tc.reason)
			}
			refusals++
			select {
			case e := <-sub:
				ku, ok := e.Data.(events.KeyUse)
				if !ok || ku.Decision != "deny" || ku.SecretID != tc.secret || ku.Method != http.MethodConnect {
					t.Errorf("%q: event %+v", req, e)
				}
			case <-time.After(2 * time.Second):
				t.Errorf("%q: no key.use alert", req)
			}
		}
	}
	if _, conns := sink.received(); conns != 0 || len(rd.addresses()) != 0 {
		t.Fatalf("dialled %v", rd.addresses())
	}
	logged := strings.ToLower(w.auditText())
	if strings.Contains(logged, strings.ToLower(known)) || strings.Contains(logged, strings.ToLower(unknown)) || strings.Contains(logged, strings.ToLower(testToken)) {
		t.Fatalf("audit carries a surrogate or the token: %s", logged)
	}
	if refusals != 12 {
		t.Fatalf("%d refusals", refusals)
	}
}

// Reserved names, addresses spelled as names, non-canonical ports, SMTP and destinations netguard
// refuses are refused before any dial and before anyone is asked, each audited as a CONNECT; an
// allowed name is audited as the policy writes it.
func TestConnectAuthoritiesAreCheckedBeforeAnyDial(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "ok") }))
	c, rd := w.recordingCell("c1", policy.Desktop)
	for authority, reason := range map[string]string{
		"keyd.ldot:443":           policy.ReasonHostDenied,
		"x.keyd.ldot:443":         policy.ReasonHostDenied,
		"localhost:443":           policy.ReasonHostInvalid,
		"x.localhost:443":         policy.ReasonHostDenied,
		"metadata.internal:443":   policy.ReasonHostDenied,
		"printer.local:443":       policy.ReasonHostDenied,
		"home.arpa:443":           policy.ReasonHostDenied,
		"127.1:443":               policy.ReasonHostInvalid,
		"0x7f.0x1:443":            policy.ReasonHostInvalid,
		"2130706433:443":          policy.ReasonHostInvalid,
		"[::ffff:7f00:1]:443":     ReasonAddress,
		"www.example.test:0443":   policy.ReasonHostInvalid,
		"www.example.test:65536":  policy.ReasonHostInvalid,
		"www.example.test:80":     ReasonAddress,
		"www.example.test:25":     policy.ReasonSMTP,
		"a_b.example.test:443":    policy.ReasonHostInvalid,
		"*.example.test:443":      policy.ReasonHostInvalid,
		"www.example.test..:443":  policy.ReasonHostInvalid,
		":443":                    policy.ReasonHostInvalid,
		"www.example.test.:44300": ReasonAddress,
	} {
		before := len(w.lines())
		resp, _ := rawRequest(t, c, connectLine(authority, tokenLine()))
		if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != reason {
			t.Errorf("%s: %d %q, want 403 %q", authority, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), reason)
			continue
		}
		lines := w.lines()
		if len(lines) != before+1 {
			t.Fatalf("%s: %d audit lines written", authority, len(lines)-before)
		}
		if l := lines[before]; l.Kind != audit.KindConnect || l.Method != http.MethodConnect || l.Decision != audit.Deny || l.Status != http.StatusForbidden || l.Reason != reason {
			t.Errorf("%s: audit %+v", authority, l)
		}
	}
	if a := rd.addresses(); len(a) != 0 {
		t.Fatalf("dialled %v", a)
	}
	if err := handshakeThrough(t, c, "WWW.Example.TEST.:443", "www.example.test"); err != nil {
		t.Fatal(err)
	}
	if l := w.waitLine(func(l audit.Line) bool { return l.Mode == "passthrough" }); l.Host != "www.example.test" {
		t.Fatalf("audit %+v", l)
	}
}

// The token travels only as a Basic Proxy-Authorization, whose name may come in any case.
func TestAConnectNeedsTheTokenAsAProxyCredential(t *testing.T) {
	w := newWorld(t)
	c, rd := w.recordingCell("c1", policy.Desktop)
	good := basicAuth("cell", testToken)
	for header, want := range map[string]int{
		"proxy-authorization: Basic " + good:       http.StatusOK,
		"PROXY-AUTHORIZATION: basic " + good:       http.StatusOK,
		"Authorization: Basic " + good:             http.StatusProxyAuthRequired,
		"Proxy-Authorization: Bearer " + testToken: http.StatusProxyAuthRequired,
		"X-Note: none": http.StatusProxyAuthRequired,
	} {
		conn, err := dialListener(c)
		if err != nil {
			t.Fatal(err)
		}
		io.WriteString(conn, connectLine("www.example.test:443", header))
		conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		conn.Close()
		if err != nil || resp.StatusCode != want {
			t.Errorf("%q: %v %v, want %d", header, resp, err, want)
		}
	}
	if a := rd.addresses(); len(a) != 0 {
		t.Fatalf("dialled %v", a)
	}
}

// A client that trickles its ClientHello is cut off ten seconds after the 200; the deadline ends
// with the peek, so an open tunnel lives on past it.
func TestTheClientHelloHasTenSecondsAndTheTunnelOutlivesThem(t *testing.T) {
	t.Run("trickle", func(t *testing.T) {
		t.Parallel()
		w := newWorld(t)
		sink := w.byteSink("www.example.test")
		c := w.cell("c1", policy.Desktop)
		conn, _ := rawConnect(t, c, "www.example.test:443")
		hello := handshakeRecords(clientHello([]serverName{{0, "www.example.test"}}, false, nil), 1<<14)
		start := time.Now()
		stop := make(chan struct{})
		defer close(stop)
		go func() {
			for i := 0; i < len(hello)-1; i++ {
				select {
				case <-stop:
					return
				case <-time.After(400 * time.Millisecond):
				}
				if _, err := conn.Write(hello[i : i+1]); err != nil {
					return
				}
			}
		}()
		conn.SetReadDeadline(time.Now().Add(20 * time.Second))
		io.Copy(io.Discard, conn)
		if d := time.Since(start); d < 9*time.Second || d > 14*time.Second {
			t.Fatalf("the tunnel ended after %v", d)
		}
		if l := connectLine1(w); l.Reason != ReasonNotTLS {
			t.Fatalf("audit %+v", l)
		}
		if _, conns := sink.received(); conns != 0 {
			t.Fatal("the upstream was reached")
		}
	})
	t.Run("outlive", func(t *testing.T) {
		t.Parallel()
		w := newWorld(t)
		w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "ok") }))
		c := w.cell("c1", policy.Desktop)
		conn, _ := rawConnect(t, c, "www.example.test:443")
		tc := tls.Client(conn, &tls.Config{ServerName: "www.example.test", RootCAs: w.roots()})
		if err := tc.Handshake(); err != nil {
			t.Fatal(err)
		}
		time.Sleep(11 * time.Second)
		io.WriteString(tc, "GET / HTTP/1.1"+crlf+"Host: www.example.test"+crlf+crlf)
		tc.SetReadDeadline(time.Now().Add(5 * time.Second))
		resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
		if err != nil {
			t.Fatalf("after 11 s: %v", err)
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 2))
		if resp.StatusCode != 200 || string(body) != "ok" {
			t.Fatalf("after 11 s: %d %q", resp.StatusCode, body)
		}
	})
}

// CONNECTs and plain requests on one cell read the same state (the intercepted hosts, the
// generation, the audit) at once; under -race nothing they share is written unguarded, Revoke
// included.
func TestConnectAndPlainRequestsRunTogether(t *testing.T) {
	w := newWorld(t)
	w.tlsUpstream("www.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "tls") }))
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { io.WriteString(rw, "plain") }))
	c := w.cell("c1", policy.Desktop)
	stopWrites, writesDone := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(writesDone)
		for {
			select {
			case <-stopWrites:
				return
			default:
				c.mu.Lock()
				c.intercepted["changing.example.test"] = !c.intercepted["changing.example.test"]
				c.mu.Unlock()
			}
		}
	}()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			resp, err := w.client(c).Get("https://www.example.test/")
			if err != nil {
				return // Revoke may end it
			}
			resp.Body.Close()
		}()
		go func() {
			defer wg.Done()
			resp, err := w.client(c).Get("http://ports.example.test/")
			if err != nil {
				return
			}
			resp.Body.Close()
		}()
		go func() {
			defer wg.Done()
			// An upgrade reads the intercepted hosts on the plain path.
			req, _ := http.NewRequest(http.MethodGet, "http://ports.example.test/", nil)
			req.Header.Set("Connection", "Upgrade")
			req.Header.Set("Upgrade", "websocket")
			resp, err := w.client(c).Do(req)
			if err != nil {
				return
			}
			resp.Body.Close()
		}()
		if i == 4 {
			c.Revoke()
		}
	}
	wg.Wait()
	close(stopWrites)
	<-writesDone
	if resp, body := get(t, w.client(c), "https://www.example.test/"); resp.StatusCode != 200 || body != "tls" {
		t.Fatalf("afterwards: %d %q", resp.StatusCode, body)
	}
	if resp, body := get(t, w.client(c), "http://ports.example.test/"); resp.StatusCode != 200 || body != "plain" {
		t.Fatalf("afterwards: %d %q", resp.StatusCode, body)
	}
}

// A passthrough's dial hangs off the generation: Revoke during it ends the attempt, which is audited.
func TestRevokeDuringAPassthroughDialEndsIt(t *testing.T) {
	w := newWorld(t)
	d := blockingDialer{entered: make(chan struct{}, 1)}
	c := w.cellWith("c1", policy.Desktop, d)
	go func() {
		<-d.entered
		c.Revoke()
	}()
	if err := handshakeThrough(t, c, "www.example.test:443", "www.example.test"); err == nil {
		t.Fatal("a handshake through a revoked dial")
	}
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "passthrough" })
	if l.Decision != audit.Error || l.SNI != "www.example.test" {
		t.Fatalf("audit %+v", l)
	}
}

// A TLS handshake remains bounded even if a connection implementation ignores read deadlines.
// The context closes the blocked connection; both deadline operations are still attempted.
type ignoringDeadlinesConn struct {
	net.Conn
	deadlines int
}

func (c *ignoringDeadlinesConn) SetReadDeadline(time.Time) error { c.deadlines++; return nil }
func TestSNIPeekContextBoundsAConnectionIgnoringDeadlines(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	conn := &ignoringDeadlinesConn{Conn: server}
	done := make(chan error, 1)
	go func() { _, _, err := peekSNI(conn, 50*time.Millisecond); done <- err }()
	select {
	case err := <-done:
		if err == nil || conn.deadlines != 2 {
			t.Fatalf("peek: %v, %d deadlines", err, conn.deadlines)
		}
	case <-time.After(time.Second):
		server.Close()
		<-done
		t.Fatal("SNI peek ignored its handshake context")
	}
}

func TestSNIRecorderNeverReadsBeyond16KiB(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	go client.Write(make([]byte, 32<<10))
	rec := &recordingConn{Conn: server}
	n, err := rec.Read(make([]byte, 32<<10))
	if err != nil || n != 16<<10 || rec.buf.Len() != 16<<10 {
		t.Fatalf("read %d bytes, recorded %d, error %v; limit is 16 KiB", n, rec.buf.Len(), err)
	}
	if n, err := rec.Read(make([]byte, 1)); n != 0 || err != io.ErrShortBuffer {
		t.Fatalf("over limit: %d %v", n, err)
	}
}

type oneConnectionDialer struct{ conn net.Conn }

func (d oneConnectionDialer) DialContext(context.Context, string, string) (net.Conn, error) {
	return d.conn, nil
}

type blockedHelloWriteConn struct {
	net.Conn
	started, closed      chan struct{}
	writeOnce, closeOnce sync.Once
}

func (c *blockedHelloWriteConn) Write([]byte) (int, error) {
	c.writeOnce.Do(func() { close(c.started) })
	<-c.closed
	return 0, net.ErrClosed
}

func (c *blockedHelloWriteConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

// The upstream must be tracked before replaying the ClientHello: a blocked Write is not yet
// in splice, so closing only the client cannot release it when the cell is revoked.
func TestRevokeClosesAnUpstreamBlockedOnTheClientHello(t *testing.T) {
	w := newWorld(t)
	up, peer := net.Pipe()
	defer peer.Close()
	held := &blockedHelloWriteConn{Conn: up, started: make(chan struct{}), closed: make(chan struct{})}
	defer held.Close()
	c := w.cellWith("c1", policy.Desktop, oneConnectionDialer{held})
	client, resp := rawConnect(t, c, "www.example.test:443")
	defer client.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("CONNECT: %d", resp.StatusCode)
	}
	hello := handshakeRecords(clientHello([]serverName{{0, "www.example.test"}}, false, nil), 1<<14)
	if _, err := client.Write(hello); err != nil {
		t.Fatal(err)
	}
	select {
	case <-held.started:
	case <-time.After(time.Second):
		t.Fatal("upstream replay never started")
	}
	c.Revoke()
	select {
	case <-held.closed:
	case <-time.After(time.Second):
		t.Fatal("revoke did not close the blocked upstream")
	}
	w.waitLine(func(l audit.Line) bool { return l.Mode == "passthrough" && l.Decision == audit.Error })
}

func TestSpliceClosesTheClientWhenTheUpstreamEndsFirst(t *testing.T) {
	client, clientPeer := net.Pipe()
	up, upPeer := net.Pipe()
	defer clientPeer.Close()
	defer client.Close()
	defer up.Close()
	defer upPeer.Close()
	done := make(chan struct{})
	go func() { splice(client, up); close(done) }()
	upPeer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("upstream EOF left the client-to-upstream copy open")
	}
	if n, err := clientPeer.Read(make([]byte, 1)); n != 0 || err != io.EOF {
		t.Fatalf("client still open: %d %v", n, err)
	}
}

func TestGoproxyCannotUseItsDefaultDialers(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	w := newWorld(t)
	p := w.cell("c1", policy.Desktop).newConnectProxy()
	if p.ConnectDial != nil || p.ConnectDialWithReq != nil {
		t.Fatal("goproxy CONNECT dialing remains enabled")
	}
	if conn, err := p.Tr.DialContext(context.Background(), "tcp", "127.0.0.1:1"); conn != nil || err != errNoDial {
		t.Fatalf("goproxy transport dial: %v, %v", conn, err)
	}
	if sameHost("", "") {
		t.Fatal("empty SNI matched")
	}
}

func TestABoundSecretHostNeverGetsUninspectedPassthrough(t *testing.T) {
	w := newWorld(t)
	w.secret(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, echoed)
	c, rd := w.recordingCell("c1", policy.Desktop)
	conn, resp := rawConnect(t, c, "api.example.test:443")
	defer conn.Close()
	if resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != "interception-unavailable" {
		t.Fatalf("bound host entered a tunnel: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if len(rd.addresses()) != 0 {
		t.Fatalf("dialled %v", rd.addresses())
	}
}

func TestInterceptedHostSnapshotsRemainStableDuringBindingChanges(t *testing.T) {
	w := newWorld(t)
	c := w.cell("c1", policy.Desktop)
	var wg sync.WaitGroup
	for reader := 0; reader < 8; reader++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 1000 {
				snapshot := c.interceptedHosts()
				first := true
				var value bool
				for _, current := range snapshot {
					if first {
						value, first = current, false
					}
					if current != value {
						t.Error("snapshot mixed two binding generations")
						return
					}
				}
			}
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for generation := range 1000 {
			c.mu.Lock()
			for host := range 128 {
				c.intercepted[fmt.Sprintf("host-%d.example.test", host)] = generation%2 == 0
			}
			c.mu.Unlock()
		}
	}()
	wg.Wait()
}

// An upload may signal end-of-body with a TCP half-close and then wait for its receipt.
func TestSpliceKeepsUploadReceiptAfterClientHalfClose(t *testing.T) {
	for _, wrapped := range []bool{false, true} {
		t.Run(fmt.Sprint("sniffed=", wrapped), func(t *testing.T) {
			pair := func() (*net.TCPConn, *net.TCPConn) {
				ln, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
				if err != nil {
					t.Fatal(err)
				}
				defer ln.Close()
				a, err := net.DialTCP("tcp4", nil, ln.Addr().(*net.TCPAddr))
				if err != nil {
					t.Fatal(err)
				}
				b, err := ln.AcceptTCP()
				if err != nil {
					t.Fatal(err)
				}
				for _, c := range []*net.TCPConn{a, b} {
					c.SetDeadline(time.Now().Add(2 * time.Second))
					t.Cleanup(func() { c.Close() })
				}
				return a, b
			}
			app, client := pair()
			up, server := pair()
			var input net.Conn = client
			if wrapped {
				input = &replayConn{Conn: client}
			}
			done := make(chan struct{})
			go func() { splice(input, up); close(done) }()
			payload := bytes.Repeat([]byte("image-data"), 32768)
			go func() { app.Write(payload); app.CloseWrite() }()
			got, err := io.ReadAll(server)
			if err != nil || !bytes.Equal(got, payload) {
				t.Fatalf("upload: %d bytes, %v", len(got), err)
			}
			if _, err := io.WriteString(server, "upload accepted"); err != nil {
				t.Fatal(err)
			}
			server.Close()
			receipt, err := io.ReadAll(app)
			if err != nil || string(receipt) != "upload accepted" {
				t.Fatalf("receipt: %q, %v", receipt, err)
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("relay did not finish")
			}
		})
	}
}
