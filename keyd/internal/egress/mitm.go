package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

var errSNI = errors.New("egress: client hello names another host")

// mitm terminates TLS for an intercepted host with a leaf from the cell's CA, then serves the
// requests inside the tunnel with net/http, each one checked against the host the CONNECT and
// the SNI named. Upstream, the request goes to that host only, never to the Host a request names.
func (c *Cell) mitm(client net.Conn, t policy.Target, line audit.Line) {
	defer client.Close()
	start := time.Now()
	g := c.current()
	defer g.track(client)()
	line.Mode = "mitm"
	record := func(decision, reason string, err error) {
		line.Decision, line.Reason, line.DurationMs = decision, reason, msSince(start)
		if err != nil {
			line.Detail = err.Error()
		}
		c.record(line)
	}
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		record(audit.Error, ReasonClientGone, err)
		return
	}
	client.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReader(client)
	if first, err := br.Peek(1); err != nil || first[0] != 0x16 {
		record(audit.Deny, ReasonNotTLS, err)
		return
	}
	mismatch := false
	tc := tls.Server(&bufferedConn{Conn: client, r: br}, &tls.Config{
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"http/1.1"},
		GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
			line.SNI = h.ServerName
			if !sameHost(h.ServerName, t.Host) {
				mismatch = true
				return nil, errSNI
			}
			return c.cfg.CA.Leaf(t.Host)
		},
	})
	ctx, cancel := context.WithTimeout(g.ctx, 10*time.Second)
	err := tc.HandshakeContext(ctx)
	cancel()
	client.SetReadDeadline(time.Time{})
	switch {
	case mismatch:
		record(audit.Deny, ReasonSNIMismatch, nil)
		return
	case err != nil:
		record(audit.Deny, ReasonHandshake, err)
		return
	}
	line.Status = http.StatusOK
	record(audit.Allow, "", nil)
	srv := &http.Server{
		Handler:                      c.innerHandler(t.Host, g),
		ReadHeaderTimeout:            30 * time.Second,
		MaxHeaderBytes:               maxHeaderBytes,
		DisableGeneralOptionsHandler: true,
		IdleTimeout:                  2 * time.Minute,
		ErrorLog:                     log.New(io.Discard, "", 0),
		BaseContext:                  func(net.Listener) context.Context { return g.ctx },
	}
	srv.Serve(newOneConnListener(tc))
}

func (c *Cell) innerHandler(host string, g *generation) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		line := audit.Line{Kind: audit.KindRequest, Mode: "mitm", Method: r.Method, Host: host, Path: r.URL.Path}
		dest := keys.Dest{Cell: c.cfg.CellID, Scheme: "https", Host: host}
		if !hostIs(r.Host, host) || (r.URL.IsAbs() && (r.URL.Scheme != "https" || !hostIs(r.URL.Host, host))) {
			// A surrogate in the Host header is refused and alerted like one anywhere else.
			u := *r.URL
			u.Host = r.Host
			if v := c.deps.Registry.Inspect(dest, r.Method, &u, r.Header); !v.Allow && v.SurrogateID != "" {
				line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
				c.deny(w, line, http.StatusForbidden, v.Reason)
				return
			}
			c.deny(w, line, http.StatusMisdirectedRequest, ReasonHostMismatch)
			return
		}
		target := &url.URL{Scheme: "https", Host: host, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
		c.forward(w, r, route{dest: dest, target: target, line: line, gen: g})
	})
}

func hostIs(authority, host string) bool {
	h, port, err := net.SplitHostPort(authority)
	if err != nil {
		h, port = authority, "443"
	}
	return port == "443" && sameHost(h, host)
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.r.Read(p) }

// oneConnListener hands http.Server one connection and ends Serve when that connection closes.
type oneConnListener struct {
	conn     net.Conn
	mu       sync.Mutex
	accepted bool
	done     chan struct{}
	once     sync.Once
}

func newOneConnListener(conn net.Conn) *oneConnListener {
	l := &oneConnListener{done: make(chan struct{})}
	l.conn = &closeHook{Conn: conn, onClose: func() { l.Close() }}
	return l
}

func (l *oneConnListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	if !l.accepted {
		l.accepted = true
		l.mu.Unlock()
		return l.conn, nil
	}
	l.mu.Unlock()
	<-l.done
	return nil, net.ErrClosed
}

func (l *oneConnListener) Close() error {
	l.once.Do(func() { close(l.done) })
	return nil
}

func (l *oneConnListener) Addr() net.Addr { return l.conn.LocalAddr() }

type closeHook struct {
	net.Conn
	onClose func()
	once    sync.Once
}

func (c *closeHook) Close() error {
	err := c.Conn.Close()
	c.once.Do(c.onClose)
	return err
}
