package egress

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/elazarl/goproxy"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

const (
	ReasonNotTLS                  = "not-tls"
	ReasonSNIMismatch             = "sni-mismatch"
	ReasonInterceptionUnavailable = "interception-unavailable"
)

var errNoDial = errors.New("egress: goproxy must not dial; every CONNECT is hijacked or refused")

// newConnectProxy configures goproxy to hand every CONNECT to keyd. Its own dialing and transport,
// which skip TLS verification and honour HTTPS_PROXY, are disabled.
func (c *Cell) newConnectProxy() *goproxy.ProxyHttpServer {
	p := goproxy.NewProxyHttpServer()
	p.Logger = log.New(io.Discard, "", 0)
	p.ConnectDial = nil
	p.ConnectDialWithReq = nil
	p.Tr = &http.Transport{DialContext: func(context.Context, string, string) (net.Conn, error) { return nil, errNoDial }}
	p.OnRequest().HandleConnectFunc(c.handleConnect)
	return p
}

func (c *Cell) handleConnect(hostport string, ctx *goproxy.ProxyCtx) (*goproxy.ConnectAction, string) {
	via := viaOf(ctx.Req)
	line := audit.Line{Kind: audit.KindConnect, Method: http.MethodConnect, Host: hostport, Via: via}
	// Inspect holds the authority to the destination's host, so it gets the parsed one; a host that
	// does not parse keeps its own reason unless a surrogate was found.
	t, reason := policy.ParseHostPort(hostport, 0)
	address := false
	if reason == policy.ReasonIPLiteral {
		t, reason = policy.ParseAddress(hostport)
		address = reason == ""
	}
	if v := c.deps.Registry.Inspect(keys.Dest{Cell: c.cfg.CellID, Scheme: "connect", Host: t.Host}, http.MethodConnect, ctx.Req.URL, ctx.Req.Header); !v.Allow && (reason == "" || v.SurrogateID != "") {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		return c.refuseConnect(ctx, line, v.Reason)
	}
	if reason != "" {
		return c.refuseConnect(ctx, line, reason)
	}
	destination, reason := c.captureDestination(ctx.Req, t)
	if reason != "" {
		return c.refuseConnect(ctx, line, reason)
	}
	line.Host = t.Host
	var d policy.Decision
	if !address {
		d = c.cfg.Policy.Connect(t, c.interceptedHosts())
	}
	if address || d.Reason == policy.ReasonPort {
		return c.handleOther(ctx, t, via, line, destination)
	}
	if !d.Allow {
		return c.refuseConnect(ctx, line, d.Reason)
	}
	if d.MITM {
		return c.hijack(func(client net.Conn) { c.mitm(client, t, line) }), hostport
	}
	// A bound host absent from this cell's CA must fail closed rather than returning an
	// encrypted response without the response scrubber seeing it.
	if len(c.boundTo(keys.Dest{Cell: c.cfg.CellID, Scheme: "https", Host: t.Host})) > 0 {
		return c.refuseConnect(ctx, line, ReasonInterceptionUnavailable)
	}
	return c.hijack(func(client net.Conn) { c.passthrough(client, t, line, destination) }), hostport
}

// handleOther is every CONNECT but the web's 443: it is tunnelled as raw TCP when policy allows it
// outright, or once the daemon answers yes for the user.
func (c *Cell) handleOther(ctx *goproxy.ProxyCtx, t policy.Target, via string, line audit.Line, destination string) (*goproxy.ConnectAction, string) {
	line.DestPort = t.Port
	g := c.current()
	d := c.cfg.Policy.Other(t, c.interceptedHosts())
	if !d.Allow && !d.Ask {
		return c.refuseConnect(ctx, line, d.Reason)
	}
	// Keys go only to their own hosts over 443, where keyd terminates them; nothing else may carry
	// a bound host's answers past the scrubber.
	if len(c.boundTo(keys.Dest{Cell: c.cfg.CellID, Scheme: "https", Host: t.Host})) > 0 {
		return c.refuseConnect(ctx, line, policy.ReasonBoundPort)
	}
	if reason := c.guard(g, t); reason != "" {
		return c.refuseConnect(ctx, line, reason)
	}
	if d.Ask {
		app, reason := c.ask(ctx.Req, g, t, via)
		line.App = app
		if reason != "" {
			return c.refuseConnect(ctx, line, reason)
		}
	}
	return c.hijack(func(client net.Conn) { c.tunnel(client, g, t, line, destination) }), net.JoinHostPort(t.Host, strconv.Itoa(t.Port))
}

func (c *Cell) hijack(fn func(client net.Conn)) *goproxy.ConnectAction {
	return &goproxy.ConnectAction{Action: goproxy.ConnectHijack, Hijack: func(_ *http.Request, client net.Conn, _ *goproxy.ProxyCtx) {
		fn(client)
	}}
}

func (c *Cell) refuseConnect(ctx *goproxy.ProxyCtx, line audit.Line, reason string) (*goproxy.ConnectAction, string) {
	line.Decision, line.Reason, line.Status = audit.Deny, reason, http.StatusForbidden
	c.record(line)
	resp := goproxy.NewResponse(ctx.Req, goproxy.ContentTypeText, http.StatusForbidden, "keyd: "+reason+"\n")
	resp.Header.Set("X-Keyd-Reason", reason)
	ctx.Resp = resp
	return goproxy.RejectConnect, ""
}

// passthrough relays an allowed host's TLS untouched once its ClientHello names that host.
func (c *Cell) passthrough(client net.Conn, t policy.Target, line audit.Line, destination string) {
	defer client.Close()
	start := time.Now()
	g := c.current()
	defer g.track(client)()
	line.Mode = "passthrough"
	finish := func(decision, reason string, err error) {
		line.Decision, line.Reason = decision, reason
		if err != nil {
			line.Detail = err.Error()
		}
		line.DurationMs = msSince(start)
		c.record(line)
	}
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		finish(audit.Error, ReasonClientGone, err)
		return
	}
	// A program that ignores the proxy may speak its own protocol on 443. That is no more than its
	// captured port 80 may do, so it is relayed raw; anything that starts as TLS is still held to
	// its SNI.
	if line.Via == ViaCapture {
		first, err := readStart(client, 10*time.Second)
		if err != nil {
			finish(audit.Deny, ReasonNotTLS, err)
			return
		}
		client = &replayConn{Conn: client, pending: first}
		if !looksTLS(first) {
			c.raw(client, g, t, line, start, destination)
			return
		}
	}
	sni, hello, err := peekSNI(client, 10*time.Second)
	if err != nil {
		finish(audit.Deny, ReasonNotTLS, err)
		return
	}
	line.SNI = sni
	if !sameHost(sni, t.Host) {
		finish(audit.Deny, ReasonSNIMismatch, nil)
		return
	}
	up, err := c.deps.Dialer.DialContext(g.ctx, "tcp", connectDestination(t, destination))
	if err != nil {
		decision, reason := dialOutcome(err)
		finish(decision, reason, err)
		return
	}
	defer up.Close()
	defer g.track(up)()
	if _, err := up.Write(hello); err != nil {
		finish(audit.Error, ReasonUpstream, err)
		return
	}
	in, out := splice(client, up)
	line.BytesIn, line.BytesOut = in+int64(len(hello)), out
	line.Status = http.StatusOK
	if g.ctx.Err() != nil {
		finish(audit.Error, ReasonRevoked, nil)
		return
	}
	finish(audit.Allow, "", nil)
}

// raw relays a captured connection to its named host as it is, with what was read already.
func (c *Cell) raw(client net.Conn, g *generation, t policy.Target, line audit.Line, start time.Time, destination string) {
	line.Mode = "raw"
	up, err := c.deps.Dialer.DialContext(g.ctx, "tcp", connectDestination(t, destination))
	if err != nil {
		line.Decision, line.Reason = dialOutcome(err)
		line.Detail, line.DurationMs = err.Error(), msSince(start)
		c.record(line)
		return
	}
	defer up.Close()
	defer g.track(up)()
	line.BytesIn, line.BytesOut = splice(client, up)
	line.Status, line.DurationMs = http.StatusOK, msSince(start)
	line.Decision = audit.Allow
	if g.ctx.Err() != nil {
		line.Decision, line.Reason = audit.Error, ReasonRevoked
	}
	c.record(line)
}

// readStart reads the first bytes a program sends, at least the two that tell TLS apart.
func readStart(conn net.Conn, timeout time.Duration) ([]byte, error) {
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		return nil, err
	}
	defer conn.SetReadDeadline(time.Time{})
	buf := make([]byte, 4096)
	n, err := io.ReadAtLeast(conn, buf, 2)
	if err != nil {
		return nil, err
	}
	return buf[:n], nil
}

// looksTLS reports whether a stream starts with a TLS handshake record (type 22, version 3.x).
func looksTLS(start []byte) bool {
	return len(start) >= 2 && start[0] == 0x16 && start[1] == 0x03
}

// replayConn reads what was already read from Conn before reading Conn again.
type replayConn struct {
	net.Conn
	pending []byte
}

func (c *replayConn) Read(p []byte) (int, error) {
	if len(c.pending) > 0 {
		n := copy(p, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	return c.Conn.Read(p)
}

// sameHost compares in ASCII only: strings.EqualFold also folds Unicode, which would take U+212A
// (Kelvin) for a k. host comes from ParseHostPort, lower-case ASCII.
func sameHost(sni, host string) bool {
	if sni == "" || strings.ContainsFunc(sni, func(r rune) bool { return r > unicode.MaxASCII }) {
		return false
	}
	return strings.ToLower(strings.TrimSuffix(sni, ".")) == host
}

// An upload's EOF ends only its sending side: the server can still return a receipt.
// Upstream completion or any copy failure closes both ends; revocation also closes both
// through generation tracking, including while a half-closed upload awaits its response.
func splice(client, up net.Conn) (in, out int64) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		var err error
		in, err = io.Copy(up, client)
		if err == nil {
			if writer, ok := up.(interface{ CloseWrite() error }); ok && writer.CloseWrite() == nil {
				return
			}
		}
		up.Close()
		client.Close()
	}()
	go func() {
		defer wg.Done()
		out, _ = io.Copy(client, up)
		client.Close()
		up.Close()
	}()
	wg.Wait()
	return in, out
}

// A captured app may have chosen a specific CDN node independently of DNS. Keep the
// observed hostname for policy and SNI checks, but dial its original public endpoint.
// Only the gate's separate credential may supply this metadata. Intercepted secret
// hosts still use mitm's own verified DNS route, never this destination override.
const originalDestinationHeader = "X-Localdot-Original-Destination"
const reasonCaptureDestination = "invalid-capture-destination"

func (c *Cell) captureDestination(r *http.Request, t policy.Target) (string, string) {
	values := r.Header.Values(originalDestinationHeader)
	if len(values) == 0 {
		return "", ""
	}
	if viaOf(r) != ViaCapture || len(values) != 1 {
		return "", reasonCaptureDestination
	}
	ap, err := netip.ParseAddrPort(values[0])
	if err != nil || ap.Addr().Zone() != "" || int(ap.Port()) != t.Port {
		return "", reasonCaptureDestination
	}
	target := policy.Target{Host: ap.Addr().String(), Port: t.Port}
	if reason := c.guard(c.current(), target); reason != "" {
		return "", reason
	}
	return ap.String(), ""
}

func connectDestination(t policy.Target, destination string) string {
	if destination != "" {
		return destination
	}
	return absolute(net.JoinHostPort(t.Host, strconv.Itoa(t.Port)))
}
