package egress

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

const (
	ReasonAskDenied  = "approval-denied"
	ReasonAskTimeout = "approval-timeout"
	ReasonAskLimit   = "approval-queue-full"
	ReasonCaptureUse = "capture-connect-only"

	ViaProxy   = "proxy"
	ViaCapture = "capture"

	// A held connection waits this long for the user, then is refused; the card stays.
	DefaultAskHold = 2 * time.Minute
	// Held connections keep their slot of the cell's 64, so only some may wait at once.
	maxPendingAsks = 16
	sourceHeader   = "X-Localdot-Source"
)

var ErrUnknownAsk = errors.New("egress: no such held connection")

// Ask is a connection keyd holds for the daemon's answer.
type Ask struct {
	ID     string    `json:"id"`
	Host   string    `json:"host"`
	Port   int       `json:"port"`
	Source int       `json:"source,omitempty"`
	Via    string    `json:"via"`
	Since  time.Time `json:"since"`
}

type answer struct {
	allow bool
	app   string
}

type pendingAsk struct {
	Ask
	answered chan answer
}

type askBook struct {
	mu      sync.Mutex
	pending map[string]*pendingAsk
}

func (b *askBook) open(a Ask) (*pendingAsk, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pending) >= maxPendingAsks {
		return nil, false
	}
	if b.pending == nil {
		b.pending = map[string]*pendingAsk{}
	}
	p := &pendingAsk{Ask: a, answered: make(chan answer, 1)}
	b.pending[a.ID] = p
	return p, true
}

func (b *askBook) close(id string) {
	b.mu.Lock()
	delete(b.pending, id)
	b.mu.Unlock()
}

func (b *askBook) list() []Ask {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Ask, 0, len(b.pending))
	for _, p := range b.pending {
		out = append(out, p.Ask)
	}
	slices.SortFunc(out, func(x, y Ask) int { return x.Since.Compare(y.Since) })
	return out
}

func (b *askBook) answer(id string, a answer) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	p, ok := b.pending[id]
	if !ok {
		return ErrUnknownAsk
	}
	delete(b.pending, id)
	p.answered <- a
	return nil
}

// Asks lists the connections this cell holds for an answer, oldest first.
func (c *Cell) Asks() []Ask { return c.asks.list() }

// Answer lets a held connection through or refuses it; app names the program for the audit.
func (c *Cell) Answer(id string, allow bool, app string) error {
	return c.asks.answer(id, answer{allow: allow, app: app})
}

type viaKey struct{}

func withVia(r *http.Request, via string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), viaKey{}, via))
}

func viaOf(r *http.Request) string {
	if via, ok := r.Context().Value(viaKey{}).(string); ok {
		return via
	}
	return ViaProxy
}

// sourceOf is the local port of the computer's program, which the gate or the computer's proxy
// forwarder reports; it only helps the daemon name the program and never decides anything.
func sourceOf(r *http.Request) int {
	values := r.Header.Values(sourceHeader)
	if len(values) != 1 || !canonicalNumber(values[0]) {
		return 0
	}
	port, err := strconv.Atoi(values[0])
	if err != nil || port < 1 || port > 65535 {
		return 0
	}
	return port
}

func canonicalNumber(s string) bool {
	return len(s) > 0 && len(s) <= 5 && s[0] != '0' && !strings.ContainsFunc(s, func(r rune) bool { return r < '0' || r > '9' })
}

// checker is the part of *netguard.Dialer that refuses an address without dialling it.
type checker interface {
	Check(ctx context.Context, network, address string) error
}

// guard refuses a destination netguard would refuse before anything is dialled or anyone asked:
// the Mac, its networks, link-local and metadata addresses. The dial checks it again.
func (c *Cell) guard(g *generation, t policy.Target) string {
	check, ok := c.deps.Dialer.(checker)
	if !ok {
		return ""
	}
	ctx, cancel := context.WithTimeout(g.ctx, 10*time.Second)
	defer cancel()
	if err := check.Check(ctx, "tcp", absolute(net.JoinHostPort(t.Host, strconv.Itoa(t.Port)))); err != nil {
		if g.ctx.Err() != nil {
			return ReasonRevoked
		}
		_, reason := dialOutcome(err)
		return reason
	}
	return ""
}

// ask holds the connection until the daemon answers, the hold runs out, the cell is stopped or
// the program gives up.
func (c *Cell) ask(r *http.Request, g *generation, t policy.Target, via string) (string, string) {
	id, err := askID()
	if err != nil {
		return "", ReasonUpstream
	}
	p, ok := c.asks.open(Ask{ID: id, Host: t.Host, Port: t.Port, Source: sourceOf(r), Via: via, Since: time.Now().UTC()})
	if !ok {
		return "", ReasonAskLimit
	}
	defer c.asks.close(id)
	c.deps.Events.Publish(events.Event{Type: events.TypeAsk, Cell: c.cfg.CellID, Data: events.Ask{
		ID: id, Host: t.Host, Port: t.Port, Source: p.Source, Via: via,
	}})
	hold := c.cfg.AskHold
	if hold <= 0 {
		hold = DefaultAskHold
	}
	timer := time.NewTimer(hold)
	defer timer.Stop()
	select {
	case a := <-p.answered:
		if !a.allow {
			return a.app, ReasonAskDenied
		}
		return a.app, ""
	case <-timer.C:
		return "", ReasonAskTimeout
	case <-g.ctx.Done():
		return "", ReasonRevoked
	case <-r.Context().Done():
		return "", ReasonClientGone
	}
}

func askID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// tunnel relays raw TCP to the destination once it is dialled: a refusal at the dial (netguard
// again, after a fresh lookup) reaches the program as a CONNECT answer, never as a dropped tunnel.
// The kill switch closes both ends.
func (c *Cell) tunnel(client net.Conn, g *generation, t policy.Target, line audit.Line, destination string) {
	defer client.Close()
	start := time.Now()
	defer g.track(client)()
	line.Mode = "tunnel"
	finish := func(decision, reason string, err error) {
		line.Decision, line.Reason = decision, reason
		if err != nil {
			line.Detail = err.Error()
		}
		line.DurationMs = msSince(start)
		c.record(line)
	}
	up, err := c.deps.Dialer.DialContext(g.ctx, "tcp", connectDestination(t, destination))
	if err != nil {
		decision, reason := dialOutcome(err)
		if g.ctx.Err() != nil {
			decision, reason = audit.Error, ReasonRevoked
		}
		status := http.StatusBadGateway
		if reason == ReasonAddress {
			status = http.StatusForbidden
		}
		line.Status = status
		refuseHijacked(client, status, reason)
		finish(decision, reason, err)
		return
	}
	defer up.Close()
	defer g.track(up)()
	if _, err := io.WriteString(client, "HTTP/1.1 200 Connection established\r\n\r\n"); err != nil {
		finish(audit.Error, ReasonClientGone, err)
		return
	}
	line.Status = http.StatusOK
	line.BytesIn, line.BytesOut = splice(client, up)
	if g.ctx.Err() != nil {
		finish(audit.Error, ReasonRevoked, nil)
		return
	}
	finish(audit.Allow, "", nil)
}

func refuseHijacked(client net.Conn, status int, reason string) {
	client.SetWriteDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(client, "HTTP/1.1 "+strconv.Itoa(status)+" "+http.StatusText(status)+"\r\nX-Keyd-Reason: "+reason+
		"\r\nContent-Type: text/plain\r\nContent-Length: "+strconv.Itoa(len("keyd: "+reason+"\n"))+"\r\nConnection: close\r\n\r\nkeyd: "+reason+"\n")
}
