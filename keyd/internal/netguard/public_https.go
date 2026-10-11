package netguard

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"time"
)

// HTTPSPublicIPv4 is the fallback for networks that block NAT-PMP/STUN UDP. Use
// the same third party as default STUN. Only a fixed, credential-free request is
// sent. A direct IPv4 connection is essential: an environment proxy or an IPv6
// answer could identify a different route from the IPv4 NAT we must protect.
func HTTPSPublicIPv4(ctx context.Context, timeout time.Duration) (netip.Addr, error) {
	client := publicHTTPClient(timeout)
	defer client.CloseIdleConnections()
	return traceAddr(ctx, client, "https://www.cloudflare.com/cdn-cgi/trace")
}

func publicHTTPClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: timeout}
	return &http.Client{
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Transport: &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, _ string, address string) (net.Conn, error) {
				return dialer.DialContext(ctx, "tcp4", address)
			},
			TLSHandshakeTimeout: timeout,
			DisableKeepAlives:   true,
		},
	}
}

func traceAddr(ctx context.Context, client *http.Client, endpoint string) (netip.Addr, error) {
	fail := func() (netip.Addr, error) { return netip.Addr{}, fmt.Errorf("HTTPS public-address lookup failed") }
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil || req.URL.Scheme != "https" {
		return fail()
	}
	req.Header.Set("User-Agent", "localDot-network-check")
	res, err := client.Do(req)
	if err != nil {
		return fail()
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fail()
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 4097))
	if err != nil || len(body) > 4096 {
		return fail()
	}
	var address netip.Addr
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "ip=") {
			continue
		}
		if address.IsValid() {
			return fail()
		}
		address, err = netip.ParseAddr(strings.TrimSpace(strings.TrimPrefix(line, "ip=")))
		if err != nil || !publicIPv4(address) {
			return fail()
		}
	}
	if !address.IsValid() {
		return fail()
	}
	return address, nil
}
