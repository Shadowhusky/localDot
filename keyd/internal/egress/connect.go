package egress

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/elazarl/goproxy"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

const (
	ReasonNotTLS      = "not-tls"
	ReasonSNIMismatch = "sni-mismatch"
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
	line := audit.Line{Kind: audit.KindConnect, Method: http.MethodConnect, Host: hostport}
	// Inspect holds the authority to the destination's host, so it gets the parsed one; a host that
	// does not parse keeps its own reason unless a surrogate was found.
	t, reason := policy.ParseHostPort(hostport, 0)
	if v := c.deps.Registry.Inspect(keys.Dest{Cell: c.cfg.CellID, Scheme: "connect", Host: t.Host}, http.MethodConnect, ctx.Req.URL, ctx.Req.Header); !v.Allow && (reason == "" || v.SurrogateID != "") {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		return c.refuseConnect(ctx, line, v.Reason)
	}
	if reason != "" {
		return c.refuseConnect(ctx, line, reason)
	}
	line.Host = t.Host
	d := c.cfg.Policy.Connect(t, c.intercepted)
	if !d.Allow {
		return c.refuseConnect(ctx, line, d.Reason)
	}
	return c.hijack(func(client net.Conn) { c.passthrough(client, t, line) }), hostport
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
func (c *Cell) passthrough(client net.Conn, t policy.Target, line audit.Line) {
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
	up, err := c.deps.Dialer.DialContext(g.ctx, "tcp", net.JoinHostPort(t.Host, "443"))
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

func sameHost(sni, host string) bool {
	return sni != "" && strings.EqualFold(strings.TrimSuffix(sni, "."), host)
}

// splice copies both ways until either side ends, then closes both.
func splice(client, up net.Conn) (in, out int64) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		in, _ = io.Copy(up, client)
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
