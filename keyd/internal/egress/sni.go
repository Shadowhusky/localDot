// Adapted from iron-proxy v0.52.0 internal/proxy/snipeek.go, Copyright the iron-proxy authors,
// Apache-2.0 (third_party/iron-proxy/LICENSE). Changed: renamed, the error reports whether a
// ClientHello was seen at all, and the size cap comes from the caller's package.
package egress

import (
	"bytes"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

const maxClientHello = 16 * 1024

var errHelloSeen = errors.New("client hello read")

// peekSNI drives crypto/tls just far enough to parse the ClientHello, returning its server name
// and the bytes read, which the caller replays upstream. Nothing is written to the client.
func peekSNI(conn net.Conn, timeout time.Duration) (string, []byte, error) {
	deadline := time.Now().Add(timeout)
	if err := conn.SetReadDeadline(deadline); err != nil {
		return "", nil, err
	}
	defer conn.SetReadDeadline(time.Time{})
	rec := &recordingConn{Conn: conn}
	var name string
	seen := false
	cfg := &tls.Config{GetConfigForClient: func(h *tls.ClientHelloInfo) (*tls.Config, error) {
		name, seen = h.ServerName, true
		return nil, errHelloSeen
	}}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	err := tls.Server(rec, cfg).HandshakeContext(ctx)
	if !seen {
		return "", nil, fmt.Errorf("no TLS client hello: %w", err)
	}
	return name, rec.buf.Bytes(), nil
}

type recordingConn struct {
	net.Conn
	buf bytes.Buffer
}

func (c *recordingConn) Read(p []byte) (int, error) {
	remaining := maxClientHello - c.buf.Len()
	if remaining <= 0 {
		return 0, io.ErrShortBuffer
	}
	if len(p) > remaining {
		p = p[:remaining]
	}
	n, err := c.Conn.Read(p)
	c.buf.Write(p[:n])
	return n, err
}

func (c *recordingConn) Write(p []byte) (int, error) { return len(p), nil }
