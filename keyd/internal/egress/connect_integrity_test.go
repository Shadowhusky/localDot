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
