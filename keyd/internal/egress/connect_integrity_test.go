package egress

import (
	"crypto/tls"
	"net/http"
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
