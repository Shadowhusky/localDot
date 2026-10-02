package egress

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// The probes of spikes/s4-keyd/run.sh, in process: S4 ran them against iron-proxy 0.52 in Docker;
// each case here states what iron-proxy did and pins what keyd does instead. Part 4b runs the
// same probes from a real cell through its gate.

const spikeValue = "real-secret-value-for-spike"

type s4 struct {
	*world
	desktop *Cell
	brain   *Cell
	caCert  *x509.Certificate
	tok     string
	hits    map[string]*atomic.Int32
	seen    chan string
}

func newS4(t *testing.T) *s4 {
	w := newWorld(t)
	s := &s4{world: w, hits: map[string]*atomic.Int32{}, seen: make(chan string, 16)}
	for _, host := range []string{"postman-echo.com", "www.postman-echo.com", "example.com"} {
		hits := new(atomic.Int32)
		s.hits[host] = hits
		w.tlsUpstream(host, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
			hits.Add(1)
			s.seen <- r.Header.Get("Authorization")
			json.NewEncoder(rw).Encode(map[string]any{"headers": map[string]string{"authorization": r.Header.Get("Authorization"), "x-api-key": r.Header.Get("X-Api-Key")}})
		}))
	}
	w.plainUpstream("postman-echo.com", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { s.hits["postman-echo.com"].Add(1) }))
	w.own = []netip.Prefix{netip.MustParsePrefix("81.2.69.160/24"), netip.MustParsePrefix("2a01:4b00:1234:5678::abcd/64"), netip.MustParsePrefix("fd12:3456:789a::1/64")}
	w.name("docker-host.example.test", "192.168.65.254")
	w.name("metadata.example.test", "169.254.169.254")
	w.name("loopback.example.test", "127.0.0.1")
	w.name("loopback6.example.test", "::1")
	w.name("zero.example.test", "0.0.0.0")
	w.name("unspecified6.example.test", "::")
	w.name("lan.example.test", "81.2.69.7")
	w.name("ula-own.example.test", "fd12:3456:789a::1")
	w.name("gua-stable.example.test", "2a01:4b00:1234:5678::abcd")
	w.name("gua-temporary.example.test", "2a01:4b00:1234:5678:9999:8888:7777:6666")
	w.secret(vault.Record{ID: "spike", Kind: vault.KindHTTP, Hosts: []string{"postman-echo.com"}, Header: "Authorization", Format: "raw"}, spikeValue)
	s.desktop, s.caCert = w.interceptingCell("desktop", policy.Desktop, "postman-echo.com")
	s.brain = w.cell("brain", policy.Brain)
	s.tok = w.mint("desktop", "spike")
	return s
}

func (s *s4) get(t *testing.T, c *Cell, rawURL string, header http.Header) (*http.Response, string) {
	return do(t, s.client(c, s.caCert), "GET", rawURL, header)
}

func (s *s4) reason(t *testing.T, c *Cell, rawURL string, header http.Header) string {
	t.Helper()
	resp, _ := s.get(t, c, rawURL, header)
	return resp.Header.Get("X-Keyd-Reason")
}

func TestS4Probes(t *testing.T) {
	s := newS4(t)
	auth := func(v string) http.Header { return http.Header{"Authorization": {v}} }

	t.Run("surrogate swapped for bound host; the reflection is scrubbed", func(t *testing.T) {
		// iron-proxy: swapped, and postman-echo reflected real-secret-value-for-spike into the cell.
		resp, body := s.get(t, s.desktop, "https://postman-echo.com/headers", auth(s.tok))
		if got := <-s.seen; got != spikeValue {
			t.Fatalf("upstream saw %q", got)
		}
		if resp.StatusCode != 200 || strings.Contains(body, spikeValue) || !strings.Contains(body, s.tok) {
			t.Fatalf("%d %s", resp.StatusCode, body)
		}
	})
	t.Run("request without a surrogate to the bound host passes untouched", func(t *testing.T) {
		// iron-proxy require: true refused it (403), so Chromium could not browse a bound host.
		resp, _ := s.get(t, s.desktop, "https://postman-echo.com/get", nil)
		if got := <-s.seen; resp.StatusCode != 200 || got != "" {
			t.Fatalf("%d %q", resp.StatusCode, got)
		}
	})
	t.Run("unknown surrogate is blocked", func(t *testing.T) {
		before := s.hits["postman-echo.com"].Load()
		if r := s.reason(t, s.desktop, "https://postman-echo.com/headers", auth("ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA")); r != "unknown-surrogate" {
			t.Fatalf("reason %q", r)
		}
		if s.hits["postman-echo.com"].Load() != before {
			t.Fatal("the upstream was reached")
		}
	})
	t.Run("unlisted hosts: the brain has no web, the desktop's deny list", func(t *testing.T) {
		if r := s.reason(t, s.brain, "http://www.wikipedia.org/", nil); r != policy.ReasonNoWeb {
			t.Fatalf("brain: %q", r)
		}
		if _, resp := rawConnect(t, s.desktop, "printer.local:443"); resp.Header.Get("X-Keyd-Reason") != policy.ReasonHostDenied {
			t.Fatalf("desktop: %q", resp.Header.Get("X-Keyd-Reason"))
		}
	})
	t.Run("private, metadata, loopback and unspecified literals are refused by name policy", func(t *testing.T) {
		for _, u := range []string{"http://192.168.65.254/", "http://169.254.169.254/", "http://127.0.0.1:1234/v1/models", "http://127.0.0.1:4799/", "http://0.0.0.0:4799/", "http://[::]:4799/", "http://[::ffff:127.0.0.1]/"} {
			if r := s.reason(t, s.desktop, u, nil); r != policy.ReasonIPLiteral {
				t.Errorf("%s: %q", u, r)
			}
		}
		if r := s.reason(t, s.desktop, "http://localhost:1234/v1/models", nil); r != policy.ReasonHostInvalid {
			t.Errorf("localhost: %q", r)
		}
	})
	t.Run("names resolving to the Mac, its networks and every private range are refused at dial", func(t *testing.T) {
		for host, rule := range map[string]string{
			"docker-host.example.test":   "docker desktop",
			"metadata.example.test":      "link-local",
			"loopback.example.test":      "loopback",
			"loopback6.example.test":     "loopback",
			"zero.example.test":          "this network",
			"unspecified6.example.test":  "unspecified",
			"lan.example.test":           "connected network",
			"ula-own.example.test":       "unique local",
			"gua-stable.example.test":    "own address",
			"gua-temporary.example.test": "connected network",
		} {
			before := len(s.lines())
			if r := s.reason(t, s.desktop, "http://"+host+"/", nil); r != ReasonAddress {
				t.Errorf("%s: %q", host, r)
				continue
			}
			if l := s.lines()[before]; !strings.Contains(l.Detail, rule) {
				t.Errorf("%s: detail %q, want %q", host, l.Detail, rule)
			}
		}
	})
	t.Run("a surrogate in a header it is not bound to is blocked", func(t *testing.T) {
		// iron-proxy passed X-Api-Key: <surrogate> upstream unswapped.
		h := auth(s.tok)
		h.Set("X-Api-Key", s.tok)
		if r := s.reason(t, s.desktop, "https://postman-echo.com/headers", h); r != "misplaced-surrogate" {
			t.Fatalf("reason %q", r)
		}
	})
	t.Run("a surrogate sent to an unbound subdomain stays in its tunnel, unswapped", func(t *testing.T) {
		// keyd does not terminate hosts no surrogate is bound to, so it cannot see this request;
		// the surrogate leaves as it is, worthless, and the real value never does.
		resp, _ := s.get(t, s.desktop, "https://www.postman-echo.com/headers", auth(s.tok))
		if got := <-s.seen; resp.StatusCode != 200 || got != s.tok {
			t.Fatalf("%d %q", resp.StatusCode, got)
		}
		if issuer := resp.TLS.PeerCertificates[0].Issuer.CommonName; issuer != "upstream test CA" {
			t.Fatalf("www.postman-echo.com was terminated (issuer %q)", issuer)
		}
	})
	t.Run("plain http to the bound host never carries the real value", func(t *testing.T) {
		// iron-proxy swapped it and sent the real value in cleartext.
		before := s.hits["postman-echo.com"].Load()
		if r := s.reason(t, s.desktop, "http://postman-echo.com/headers", auth(s.tok)); r != "misplaced-surrogate" {
			t.Fatalf("reason %q", r)
		}
		if s.hits["postman-echo.com"].Load() != before {
			t.Fatal("the plain upstream was reached")
		}
	})
	t.Run("example.com passes through with its own certificate", func(t *testing.T) {
		// iron-proxy terminated it with the cell CA, and curl and Chromium rejected the leaf.
		resp, _ := s.get(t, s.desktop, "https://example.com/", nil)
		<-s.seen
		if resp.StatusCode != 200 || resp.TLS.PeerCertificates[0].Issuer.CommonName != "upstream test CA" {
			t.Fatalf("%d", resp.StatusCode)
		}
	})
	t.Run("every audit line names its cell and listener", func(t *testing.T) {
		// iron-proxy logged remote_addr 127.0.0.1 for every request.
		for _, l := range s.lines() {
			if l.Cell == "" || l.Port == 0 {
				t.Fatalf("anonymous audit line %+v", l)
			}
		}
	})
	t.Run("plain http inside CONNECT and a Host that differs from the tunnel are refused", func(t *testing.T) {
		// iron-proxy delivered CONNECT example.com:80 + Host: postman-echo.com to postman-echo.com.
		if _, resp := rawConnect(t, s.desktop, "example.com:80"); resp.Header.Get("X-Keyd-Reason") != policy.ReasonPort {
			t.Fatalf("CONNECT :80: %q", resp.Header.Get("X-Keyd-Reason"))
		}
		for _, check := range []struct {
			auth   string
			status int
			reason string
		}{
			{"", http.StatusMisdirectedRequest, ReasonHostMismatch},
			{s.tok, http.StatusForbidden, "misplaced-surrogate"},
		} {
			before := s.hits["postman-echo.com"].Load() + s.hits["www.postman-echo.com"].Load()
			conn, _ := rawConnect(t, s.desktop, "postman-echo.com:443")
			roots := x509.NewCertPool()
			roots.AddCert(s.caCert)
			tc := tls.Client(conn, &tls.Config{ServerName: "postman-echo.com", RootCAs: roots})
			tc.SetDeadline(time.Now().Add(3 * time.Second))
			io.WriteString(tc, "GET /headers HTTP/1.1\r\nHost: www.postman-echo.com\r\nAuthorization: "+check.auth+"\r\n\r\n")
			resp, err := http.ReadResponse(bufio.NewReader(tc), nil)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			tc.Close()
			// Inspection deliberately alerts on a misplaced surrogate before
			// returning the generic host-mismatch error.
			if resp.StatusCode != check.status || resp.Header.Get("X-Keyd-Reason") != check.reason {
				t.Fatalf("Host != SNI: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
			}
			if s.hits["postman-echo.com"].Load()+s.hits["www.postman-echo.com"].Load() != before {
				t.Fatal("mismatched authority reached an upstream")
			}
		}
	})
	t.Run("every method is inspected", func(t *testing.T) {
		// iron-proxy's require skipped PROPFIND.
		resp, _ := do(t, s.client(s.desktop, s.caCert), "PROPFIND", "https://postman-echo.com/headers", auth("ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA"))
		if resp.Header.Get("X-Keyd-Reason") != "unknown-surrogate" {
			t.Fatalf("PROPFIND: %d", resp.StatusCode)
		}
	})
	t.Run("a surrogate in a URL's path or host name is refused, and alerted", func(t *testing.T) {
		// A surrogate is bound to a header, never to a URL: wherever keyd sees one there, it refuses.
		for _, u := range []string{"https://postman-echo.com/keys/" + s.tok, "http://" + s.tok + ".example.test/"} {
			if r := s.reason(t, s.desktop, u, nil); r != "misplaced-surrogate" {
				t.Errorf("%s: %q", u, r)
			}
		}
	})
	t.Run("the audit never holds the real value or a surrogate", func(t *testing.T) {
		data, _ := os.ReadFile(s.auditPath)
		if strings.Contains(string(data), spikeValue) || len(surrogate.Find(string(data))) > 0 {
			t.Fatalf("the audit log leaks: %s", data)
		}
	})
}
