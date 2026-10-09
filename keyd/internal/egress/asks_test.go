package egress

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// echoUpstream answers raw TCP on host:port by echoing every line, and counts its connections.
func (w *world) echoUpstream(host, port string) *atomic.Int32 {
	w.t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { ln.Close() })
	var conns atomic.Int32
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			conns.Add(1)
			go func() {
				defer c.Close()
				io.Copy(c, c)
			}()
		}
	}()
	w.publish(host, port, ln.Addr().String(), true)
	return &conns
}

// connectAs sends a CONNECT with the given token and extra header lines and returns the
// connection and a reader positioned at the reply.
func connectAs(t *testing.T, c *Cell, authority, token, extra string) (net.Conn, *bufio.Reader) {
	t.Helper()
	conn, err := dialListener(c)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	io.WriteString(conn, "CONNECT "+authority+" HTTP/1.1\r\nHost: "+authority+"\r\nProxy-Authorization: Basic "+
		basicAuth("cell", token)+"\r\n"+extra+"\r\n")
	return conn, bufio.NewReader(conn)
}

func reply(t *testing.T, br *bufio.Reader) *http.Response {
	t.Helper()
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func nextAsk(t *testing.T, sub <-chan events.Event) (string, events.Ask) {
	t.Helper()
	select {
	case e := <-sub:
		a, ok := e.Data.(events.Ask)
		if e.Type != events.TypeAsk || !ok {
			t.Fatalf("event %+v", e)
		}
		return e.Cell, a
	case <-time.After(2 * time.Second):
		t.Fatal("no ask was published")
	}
	return "", events.Ask{}
}

func noAsk(t *testing.T, sub <-chan events.Event) {
	t.Helper()
	select {
	case e := <-sub:
		t.Fatalf("published %+v", e)
	case <-time.After(100 * time.Millisecond):
	}
}

func echoes(t *testing.T, conn net.Conn, br *bufio.Reader) {
	t.Helper()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	io.WriteString(conn, "hello\n")
	line, err := br.ReadString('\n')
	if err != nil || line != "hello\n" {
		t.Fatalf("echo %q, %v", line, err)
	}
}

func TestAnotherPortIsHeldUntilTheUserAllowsItThenTunnelled(t *testing.T) {
	w := newWorld(t)
	conns := w.echoUpstream("chat.example.test", "5222")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	conn, br := connectAs(t, c, "chat.example.test:5222", testToken, sourceHeader+": 41234\r\n")
	cell, a := nextAsk(t, sub)
	if cell != "c1" || a.Host != "chat.example.test" || a.Port != 5222 || a.Source != 41234 || a.Via != ViaProxy {
		t.Fatalf("ask %s %+v", cell, a)
	}
	if held := c.Asks(); len(held) != 1 || held[0].ID != a.ID {
		t.Fatalf("held %+v", held)
	}
	if conns.Load() != 0 {
		t.Fatal("dialled before the answer")
	}
	if err := c.Answer(a.ID, true, "chat-app"); err != nil {
		t.Fatal(err)
	}
	if resp := reply(t, br); resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	echoes(t, conn, br)
	conn.Close()
	l := w.waitLine(func(l audit.Line) bool { return l.Mode == "tunnel" })
	if l.Decision != audit.Allow || l.Host != "chat.example.test" || l.DestPort != 5222 || l.App != "chat-app" || l.Via != ViaProxy || l.BytesIn == 0 || l.BytesOut == 0 {
		t.Fatalf("audit %+v", l)
	}
	if len(c.Asks()) != 0 || !errors.Is(c.Answer(a.ID, true, ""), ErrUnknownAsk) {
		t.Fatal("the answered ask is still held")
	}
}

func TestARefusedOrUnansweredConnectionIsRefusedCleanly(t *testing.T) {
	w := newWorld(t)
	conns := w.echoUpstream("chat.example.test", "5222")
	p, _ := policy.ForRole(policy.Desktop)
	c, err := Open(Config{CellID: "c1", Policy: p, Token: testToken, AskHold: 200 * time.Millisecond}, w.deps())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	_, br := connectAs(t, c, "chat.example.test:5222", testToken, "")
	_, a := nextAsk(t, sub)
	c.Answer(a.ID, false, "chat-app")
	if resp := reply(t, br); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != ReasonAskDenied {
		t.Fatalf("denied: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	_, br = connectAs(t, c, "chat.example.test:5222", testToken, "")
	nextAsk(t, sub)
	if resp := reply(t, br); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != ReasonAskTimeout {
		t.Fatalf("unanswered: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if conns.Load() != 0 || len(c.Asks()) != 0 {
		t.Fatalf("%d connections, %d held", conns.Load(), len(c.Asks()))
	}
	w.waitLine(func(l audit.Line) bool {
		return l.Reason == ReasonAskDenied && l.App == "chat-app" && l.DestPort == 5222 && l.Decision == audit.Deny
	})
}

// No approval reaches SMTP, the Mac, its networks, link-local or metadata: they are refused before
// anyone is asked, also when the gate captured them.
func TestFixedLimitsAreRefusedWithoutAsking(t *testing.T) {
	w := newWorld(t)
	w.name("rebind.example.test", "93.184.216.34", "10.0.0.5")
	w.name("lan.example.test", "192.168.1.10")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	for authority, reason := range map[string]string{
		"mail.example.test:25":   policy.ReasonSMTP,
		"93.184.216.34:25":       policy.ReasonSMTP,
		"169.254.169.254:80":     ReasonAddress,
		"192.168.1.10:8080":      ReasonAddress,
		"lan.example.test:8080":  ReasonAddress,
		"rebind.example.test:22": ReasonAddress,
		"[fd00::1]:8080":         ReasonAddress,
		"printer.local:9100":     policy.ReasonHostDenied,
	} {
		for _, token := range []string{testToken, testCaptureToken} {
			_, br := connectAs(t, c, authority, token, "")
			if resp := reply(t, br); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != reason {
				t.Errorf("%s: %d %q, want %q", authority, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), reason)
			}
		}
	}
	noAsk(t, sub)
}

// A rule the daemon holds can answer yes, but the dial still checks the address: a name that
// rebinds to a private address between the ask and the dial is refused.
func TestTheDialChecksTheAddressAgainAfterTheAnswer(t *testing.T) {
	w := newWorld(t)
	w.echoUpstream("chat.example.test", "5222")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	_, br := connectAs(t, c, "chat.example.test:5222", testToken, "")
	_, a := nextAsk(t, sub)
	w.mu.Lock()
	w.names["chat.example.test"] = []netip.Addr{netip.MustParseAddr("10.1.2.3")}
	w.mu.Unlock()
	c.Answer(a.ID, true, "")
	if resp := reply(t, br); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != ReasonAddress {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestTheGateCaptureTokenIsForCONNECTOnly(t *testing.T) {
	w := newWorld(t)
	conns := w.echoUpstream("plain.example.test", "80")
	w.echoUpstream("plain.example.test", "8080")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	// Plain http a program sent without the proxy is web traffic: no ask.
	conn, br := connectAs(t, c, "plain.example.test:80", testCaptureToken, sourceHeader+": 5000\r\n")
	if resp := reply(t, br); resp.StatusCode != http.StatusOK {
		t.Fatalf("captured :80: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	echoes(t, conn, br)
	noAsk(t, sub)
	if conns.Load() != 1 {
		t.Fatalf("%d connections", conns.Load())
	}
	// The same CONNECT from the proxy asks: proxies send plain http in absolute form.
	_, br = connectAs(t, c, "plain.example.test:80", testToken, "")
	_, a := nextAsk(t, sub)
	if a.Via != ViaProxy {
		t.Fatalf("ask %+v", a)
	}
	c.Answer(a.ID, false, "")
	reply(t, br)
	// Any other port the gate captured asks too, and says so.
	_, br = connectAs(t, c, "plain.example.test:8080", testCaptureToken, sourceHeader+": 5001\r\n")
	if _, a = nextAsk(t, sub); a.Via != ViaCapture || a.Source != 5001 {
		t.Fatalf("ask %+v", a)
	}
	c.Answer(a.ID, false, "")
	reply(t, br)
	resp, _ := rawRequest(t, c, "GET http://plain.example.test/ HTTP/1.1\r\nHost: plain.example.test\r\nConnection: close\r\nProxy-Authorization: Basic "+
		basicAuth("cell", testCaptureToken)+"\r\n\r\n")
	if resp.StatusCode != http.StatusBadRequest || resp.Header.Get("X-Keyd-Reason") != ReasonCaptureUse {
		t.Fatalf("plain request with the capture token: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestAnAddressAsksAndIsTunnelledOnceAllowed(t *testing.T) {
	w := newWorld(t)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err == nil {
			io.Copy(c, c)
			c.Close()
		}
	}()
	w.publish("unused.example.test", "1", ln.Addr().String(), true)
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	conn, br := connectAs(t, c, ln.Addr().String(), testCaptureToken, "")
	_, a := nextAsk(t, sub)
	if a.Host != "127.0.0.1" || strconv.Itoa(a.Port) != ln.Addr().String()[strings.LastIndex(ln.Addr().String(), ":")+1:] {
		t.Fatalf("ask %+v", a)
	}
	c.Answer(a.ID, true, "")
	if resp := reply(t, br); resp.StatusCode != http.StatusOK {
		t.Fatalf("%d", resp.StatusCode)
	}
	echoes(t, conn, br)
}

func TestABoundHostIsReachedOnlyOn443(t *testing.T) {
	w := newWorld(t)
	w.echoUpstream("api.example.test", "8443")
	w.secret(vault.Record{ID: "api", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}, "secret-value-0123456789")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	_, br := connectAs(t, c, "api.example.test:8443", testToken, "")
	if resp := reply(t, br); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != policy.ReasonBoundPort {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	noAsk(t, sub)
}

// Stop: a held connection is refused and an open tunnel is cut.
func TestRevokeRefusesHeldConnectionsAndCutsTunnels(t *testing.T) {
	w := newWorld(t)
	w.echoUpstream("chat.example.test", "5222")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	open, openBr := connectAs(t, c, "chat.example.test:5222", testToken, "")
	_, a := nextAsk(t, sub)
	c.Answer(a.ID, true, "")
	reply(t, openBr)
	echoes(t, open, openBr)
	_, heldBr := connectAs(t, c, "chat.example.test:5222", testToken, "")
	nextAsk(t, sub)
	c.Revoke()
	if resp := reply(t, heldBr); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != ReasonRevoked {
		t.Fatalf("held: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	open.SetReadDeadline(time.Now().Add(2 * time.Second))
	var timeout net.Error
	if _, err := openBr.ReadByte(); err == nil || errors.As(err, &timeout) && timeout.Timeout() {
		t.Fatalf("the tunnel stayed open: %v", err)
	}
	w.waitLine(func(l audit.Line) bool { return l.Mode == "tunnel" && l.Reason == ReasonRevoked })
}

func TestHeldConnectionsAreBounded(t *testing.T) {
	w := newWorld(t)
	w.echoUpstream("chat.example.test", "5222")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(64)
	defer cancel()
	for range maxPendingAsks {
		connectAs(t, c, "chat.example.test:5222", testToken, "")
		nextAsk(t, sub)
	}
	_, br := connectAs(t, c, "chat.example.test:5222", testToken, "")
	if resp := reply(t, br); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != ReasonAskLimit {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestAProgramThatGivesUpIsNoLongerHeld(t *testing.T) {
	w := newWorld(t)
	w.echoUpstream("chat.example.test", "5222")
	c := w.cell("c1", policy.Desktop)
	sub, cancel := w.events.Subscribe(8)
	defer cancel()
	conn, _ := connectAs(t, c, "chat.example.test:5222", testCaptureToken, "")
	nextAsk(t, sub)
	conn.Close()
	deadline := time.Now().Add(2 * time.Second)
	for len(c.Asks()) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if len(c.Asks()) != 0 {
		t.Fatal("the abandoned connection is still held")
	}
	w.waitLine(func(l audit.Line) bool { return l.Reason == ReasonClientGone && l.DestPort == 5222 })
}
