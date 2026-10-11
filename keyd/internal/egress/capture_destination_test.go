package egress

import (
	"bufio"
	"crypto/tls"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

func TestCapturedTLSKeepsTheAppsChosenCDNNode(t *testing.T) {
	w := newWorld(t)
	// Same TLS name, different destinations. DNS points to a node that does not own
	// this upload; the original address points to the node selected by the app.
	dns := w.tlsUpstream("media.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { io.WriteString(rw, "wrong node") }))
	chosen := w.tlsUpstream("media.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { io.WriteString(rw, "upload receipt") }))
	w.publish("media.example.test", "443", dns.Listener.Addr().String(), true)
	w.mu.Lock()
	w.ports["93.184.216.34:443"] = chosen.Listener.Addr().String()
	w.mu.Unlock()
	c := w.cell("c1", policy.Desktop)
	conn, br := connectAs(t, c, "media.example.test:443", testCaptureToken, originalDestinationHeader+": 93.184.216.34:443\r\n")
	defer conn.Close()
	response, err := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("CONNECT: %v %v", response, err)
	}
	// Both nodes have valid certificates for the same hostname. TLS identity alone
	// cannot tell whether DNS silently moved a request to the wrong upload node.
	tc := tls.Client(conn, &tls.Config{ServerName: "media.example.test", RootCAs: w.roots()})
	tc.SetDeadline(time.Now().Add(3 * time.Second))
	if err := tc.Handshake(); err != nil {
		t.Fatal(err)
	}
	io.WriteString(tc, "GET / HTTP/1.1\r\nHost: media.example.test\r\nConnection: close\r\n\r\n")
	res, err := http.ReadResponse(bufio.NewReader(tc), &http.Request{Method: "GET"})
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || string(body) != "upload receipt" {
		t.Fatalf("response %q: %v", body, err)
	}
}

func TestOriginalDestinationCannotBypassGateAuthenticationOrAddressGuard(t *testing.T) {
	for _, tc := range []struct{ name, token, header string }{
		{"ordinary proxy", testToken, "93.184.216.34:443"},
		{"private", testCaptureToken, "192.168.1.1:443"},
		{"loopback", testCaptureToken, "127.0.0.1:443"},
		{"metadata", testCaptureToken, "169.254.169.254:443"},
		{"wrong port", testCaptureToken, "93.184.216.34:80"},
		{"hostname", testCaptureToken, "other.example.test:443"},
		{"duplicate", testCaptureToken, "93.184.216.34:443\r\n" + originalDestinationHeader + ": 93.184.216.35:443"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := newWorld(t)
			c := w.cell("c1", policy.Desktop)
			conn, br := connectAs(t, c, "media.example.test:443", tc.token, originalDestinationHeader+": "+tc.header+"\r\n")
			defer conn.Close()
			res, err := http.ReadResponse(br, &http.Request{Method: "CONNECT"})
			if err != nil || res.StatusCode != 403 {
				t.Fatalf("response %v: %v", res, err)
			}
		})
	}
}

func TestCapturedDestinationStillChecksTLSNameAndSecretBinding(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(map[bool]string{false: "SNI mismatch", true: "bound secret"}[bound], func(t *testing.T) {
			w := newWorld(t)
			if bound {
				bearerSecret(w, "secret", "media.example.test")
				w.mint("c1", "secret")
			}
			c := w.cell("c1", policy.Desktop)
			conn, br := connectAs(t, c, "media.example.test:443", testCaptureToken, originalDestinationHeader+": 93.184.216.34:443\r\n")
			defer conn.Close()
			res := reply(t, br)
			if bound {
				if res.StatusCode != 403 {
					t.Fatalf("bound host bypassed interception: %d", res.StatusCode)
				}
				return
			}
			if res.StatusCode != 200 {
				t.Fatalf("CONNECT: %d", res.StatusCode)
			}
			tc := tls.Client(conn, &tls.Config{ServerName: "other.example.test", InsecureSkipVerify: true})
			tc.SetDeadline(time.Now().Add(time.Second))
			if err := tc.Handshake(); err == nil {
				t.Fatal("mismatched SNI passed")
			}
			w.waitLine(reasonIs(ReasonSNIMismatch))
		})
	}
}
