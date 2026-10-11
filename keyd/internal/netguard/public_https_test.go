package netguard

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHTTPSDiscoveryValidation(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
		ok         bool
	}{
		{"public", "fl=abc\nip=81.2.69.160\ncolo=LHR\n", 200, true},
		{"private", "ip=192.168.1.1\n", 200, false},
		{"v6 instead of v4", "ip=2606:4700::1111\n", 200, false},
		{"missing", "colo=LHR\n", 200, false},
		{"duplicate", "ip=81.2.69.160\nip=81.2.69.161\n", 200, false},
		{"large", "ip=81.2.69.160\n" + strings.Repeat("x", 4096), 200, false},
		{"redirect", "ip=81.2.69.160\n", 302, false},
		{"server error", "ip=81.2.69.160\n", 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.Header.Get("Authorization") != "" {
					t.Error("unexpected request")
				}
				w.Header().Set("Location", "https://example.invalid/")
				w.WriteHeader(tc.status)
				io.WriteString(w, tc.body)
			}))
			defer server.Close()
			client := publicHTTPClient(time.Second)
			client.Transport.(*http.Transport).TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig
			defer client.CloseIdleConnections()
			a, err := traceAddr(context.Background(), client, server.URL)
			if (err == nil) != tc.ok {
				t.Fatalf("address=%v error=%v", a, err)
			}
			if tc.ok && a.String() != "81.2.69.160" {
				t.Fatal(a)
			}
		})
	}
}

func TestHTTPSDiscoveryDoesNotTrustProxyRedirectOrInvalidTLS(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	client := publicHTTPClient(100 * time.Millisecond)
	defer client.CloseIdleConnections()
	if client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("environment proxy enabled")
	}
	if client.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("redirects allowed")
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ip=81.2.69.160\n") }))
	defer server.Close()
	if _, err := traceAddr(context.Background(), client, server.URL); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
	if _, err := traceAddr(context.Background(), client, "http://127.0.0.1/"); err == nil {
		t.Fatal("plaintext accepted")
	}
}

func TestHTTPSDiscoveryCancellation(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer server.Close()
	client := publicHTTPClient(time.Second)
	client.Transport.(*http.Transport).TLSClientConfig = server.Client().Transport.(*http.Transport).TLSClientConfig
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := traceAddr(ctx, client, server.URL); err == nil {
		t.Fatal("cancelled lookup succeeded")
	}
	if time.Since(started) > 500*time.Millisecond {
		t.Fatal("cancellation ignored")
	}
}

func TestLearnFallsBackToHTTPSAndDeniesTheLearnedAddress(t *testing.T) {
	p := &Public{}
	calls := 0
	d := Discovery{Router: func() (netip.Addr, error) { return netip.Addr{}, errors.New("no router") }, HTTPS: func(context.Context, time.Duration) (netip.Addr, error) {
		calls++
		return netip.MustParseAddr("81.2.69.160"), nil
	}}
	if err := p.Learn(d); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || p.Status().State != "active" || p.Status().Source != "https" {
		t.Fatal(p.Status())
	}
	if err := check(New(WithPublic(noOwn, p)), "81.2.69.160"); err == nil {
		t.Fatal("learned address not denied")
	}
	router, _ := fakeRouter(t, netip.MustParseAddr("81.2.69.161"))
	router.HTTPS = d.HTTPS
	if err := p.Learn(router); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("HTTPS called despite router success")
	}
	d.HTTPS = func(context.Context, time.Duration) (netip.Addr, error) { return netip.MustParseAddr("127.0.0.1"), nil }
	if err := (&Public{}).Learn(d); err == nil {
		t.Fatal("invalid fallback answer accepted")
	}
}

func TestLearnUsesHTTPSAfterSilentSTUN(t *testing.T) {
	silent, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	calls := 0
	d := Discovery{STUN: silent.LocalAddr().String(), Timeout: 10 * time.Millisecond, HTTPS: func(context.Context, time.Duration) (netip.Addr, error) {
		calls++
		return netip.MustParseAddr("81.2.69.160"), nil
	}}
	if err := (&Public{}).Learn(d); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("UDP timeout did not try HTTPS")
	}
	stun, _ := fakeSTUN(t, netip.MustParseAddr("81.2.69.161"), 1)
	d.STUN = stun
	if err := (&Public{}).Learn(d); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("successful STUN unnecessarily tried HTTPS")
	}
}

func TestLiveHTTPSPublicDiscovery(t *testing.T) {
	if os.Getenv("LOCALDOT_TEST_PUBLIC_DISCOVERY") != "1" {
		t.Skip("explicit live-network check")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	address, err := HTTPSPublicIPv4(ctx, 3*time.Second)
	if err != nil || !publicIPv4(address) {
		t.Fatal("live HTTPS discovery failed", err)
	}
	// Deliberately do not log the machine's public address.
}
