package egress

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// generation is what the kill switch replaces: the context every upstream request and tunnel
// hangs off, the transport whose pooled connections it closes, and the tunnels it tracks.
type generation struct {
	ctx    context.Context
	cancel context.CancelFunc
	tr     *http.Transport
	local  *http.Transport
	mu     sync.Mutex
	conns  map[net.Conn]struct{}
}

func newGeneration(d Deps) *generation {
	ctx, cancel := context.WithCancel(context.Background())
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			return d.Dialer.DialContext(ctx, network, absolute(address))
		},
		TLSClientConfig:       &tls.Config{RootCAs: d.RootCAs, MinVersion: tls.VersionTLS12},
		ForceAttemptHTTP2:     true,
		TLSHandshakeTimeout:   10 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConnsPerHost:   8,
		ExpectContinueTimeout: time.Second,
		// relay asks for gzip itself and decodes it, so it sees every coding a body has.
		DisableCompression: true,
	}
	localDial := func(context.Context, string, string) (net.Conn, error) { return nil, errNoLocal }
	if d.LocalDialer != nil {
		localDial = d.LocalDialer.DialContext
	}
	local := &http.Transport{DialContext: localDial, IdleConnTimeout: 90 * time.Second, DisableCompression: true}
	return &generation{ctx: ctx, cancel: cancel, tr: tr, local: local, conns: map[net.Conn]struct{}{}}
}

// track registers a connection for the kill switch; one opened after the switch is closed at once.
func (g *generation) track(conn net.Conn) func() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.ctx.Err() != nil {
		conn.Close()
		return func() {}
	}
	g.conns[conn] = struct{}{}
	return func() {
		g.mu.Lock()
		delete(g.conns, conn)
		g.mu.Unlock()
	}
}

func (g *generation) stop() {
	g.cancel()
	g.mu.Lock()
	for conn := range g.conns {
		conn.Close()
	}
	g.conns = map[net.Conn]struct{}{}
	g.mu.Unlock()
	g.tr.CloseIdleConnections()
	g.local.CloseIdleConnections()
}

// absolute ends a name with a dot, so the resolver's search domains never apply; the policy has
// already refused relative names. The request's Host and SNI keep the name without the dot.
func absolute(address string) string {
	host, port, err := net.SplitHostPort(address)
	if err != nil || strings.HasSuffix(host, ".") {
		return address
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return address
	}
	return net.JoinHostPort(host+".", port)
}
