package egress

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"path"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	gatewayHost    = "llm.ldot"
	maxGatewayBody = 32 << 20

	ReasonRouteUnknown      = "route-unknown"
	ReasonOpNotAllowed      = "op-not-allowed"
	ReasonSurrogateMissing  = "surrogate-missing"
	ReasonNoTask            = "no-task"
	ReasonBudgetTask        = "budget-task"
	ReasonBudgetDay         = "budget-day"
	ReasonBudgetUnavailable = "budget-unavailable"
	ReasonBodyTooLarge      = "body-too-large"
	ReasonBadJSON           = "bad-json"
	ReasonModelMissing      = "model-missing"
	ReasonModelNotAllowed   = "model-not-allowed"
	ReasonModelUnpriced     = "model-unpriced"
	ReasonChoiceCount       = "choice-count"
)

var errNoLocal = errors.New("egress: no local model servers are configured")

// The cell's own credentials for a provider are dropped; only the route's swapped key goes up.
var authHeaders = []string{"Authorization", "X-Api-Key", "X-Goog-Api-Key", "Api-Key", "Cookie"}

func isGateway(u *url.URL) bool {
	return u.User == nil && isVirtualHost(u, gatewayHost)
}

// serveGateway is the LLM gateway at http://llm.ldot/<route>/<path>: the route's real key in the
// provider's auth style, only the operations the route lists, only allowlisted models, a running
// task with room for what the request can cost, and the cost of every answer charged to it. The
// generation is taken first, so a Stop that lands while the body uploads refuses the request, and
// the request is inspected again once it may go, so a surrogate revoked meanwhile is refused.
func (c *Cell) serveGateway(w http.ResponseWriter, r *http.Request) {
	g := c.current()
	line := audit.Line{Kind: audit.KindRequest, Mode: "gateway", Method: r.Method, Host: gatewayHost, Path: r.URL.Path}
	name, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/"), "/")
	line.Route = name
	b, ok := c.gatewayRoute(name)
	if !ok {
		c.deny(w, line, http.StatusNotFound, ReasonRouteUnknown)
		return
	}
	// Joined under "/": a base URL may have no path (DeepSeek's, or a user's https://host).
	line.Host, line.Path = b.Upstream.Hostname(), path.Join("/", b.Upstream.Path, rest)
	op, ok := b.Op(r.Method, rest)
	if !ok || path.Clean(rest) != rest {
		c.deny(w, line, http.StatusForbidden, ReasonOpNotAllowed)
		return
	}
	if isUpgrade(r) {
		c.deny(w, line, http.StatusForbidden, ReasonUpgrade)
		return
	}
	dest := keys.Dest{Cell: c.cfg.CellID, Scheme: "gateway", Host: gatewayHost, Route: name}
	v := c.deps.Registry.Inspect(dest, r.Method, r.URL, r.Header)
	line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
	if !v.Allow {
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	if !b.Local && !slices.ContainsFunc(v.Swaps, func(e keys.Entry) bool { return e.Binding.Route == name }) {
		line.SecretID = b.SecretID
		c.deny(w, line, http.StatusForbidden, ReasonSurrogateMissing)
		return
	}
	if c.deps.Budget == nil || c.deps.Settings == nil {
		c.deny(w, line, http.StatusServiceUnavailable, ReasonBudgetUnavailable)
		return
	}
	lease, err := c.deps.Budget.Capture(c.cfg.CellID)
	if err != nil {
		c.refuseBudget(w, line, err)
		return
	}
	modelLease, admissionErr := g.model.Prepare()
	if admissionErr != nil {
		c.refuseModelAdmission(w, line)
		return
	}
	defer modelLease.Release()
	if !lease.AllowsRoute(name, keys.BindingIdentity(b)) {
		c.deny(w, line, http.StatusForbidden, ReasonModelNotAllowed)
		return
	}
	// A stopped generation must also interrupt a client that has not finished uploading.
	// Closing Request.Body can wait behind an in-progress Read, so interrupt the socket read.
	interrupted := make(chan struct{})
	stopInterrupt := context.AfterFunc(g.ctx, func() {
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
		close(interrupted)
	})
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxGatewayBody))
	if !stopInterrupt() {
		<-interrupted
	}
	if g.ctx.Err() != nil {
		r.Close = true
		w.Header().Set("Connection", "close")
		c.deny(w, line, http.StatusServiceUnavailable, ReasonRevoked)
		return
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.deny(w, line, http.StatusRequestEntityTooLarge, ReasonBodyTooLarge)
		} else {
			c.deny(w, line, http.StatusBadRequest, ReasonBadRequest)
		}
		return
	}
	model := ""
	switch {
	case op.Model:
		model = op.ModelFrom(rest)
	case r.Method == http.MethodPost:
		if model, err = llm.ModelFromJSON(body); err != nil {
			c.deny(w, line, http.StatusBadRequest, ReasonBadJSON)
			return
		}
		if model == "" {
			c.deny(w, line, http.StatusBadRequest, ReasonModelMissing)
			return
		}
	}
	line.Model = model
	var price llm.Price
	if model != "" {
		flat := false
		if lease.Snapshot() {
			price, ok = lease.Price(name, model)
			flat = lease.Flat(name)
		} else {
			price, ok = c.deps.Settings.Price(name, model)
		}
		if !ok {
			c.deny(w, line, http.StatusForbidden, ReasonModelNotAllowed)
			return
		}
		// No price, no route (Part 5a's amendment, P5a-R32): a model priced at nothing both ways
		// would spend outside the budget wherever the provider bills. Only a local server's is free,
		// and a route the task's own snapshot marks flat: a plan the provider bills at a flat rate.
		if !b.Local && !flat && price.Input == 0 && price.Output == 0 {
			c.deny(w, line, http.StatusForbidden, ReasonModelUnpriced)
			return
		}
	}
	var hold *llm.Hold
	if model != "" && !op.Free {
		if hold, body, ok = c.reserve(w, r, g, line, op, price, model, body, lease); !ok {
			return
		}
		defer hold.Release()
	}
	if g.ctx.Err() != nil || !c.deps.Budget.Current(lease) {
		c.deny(w, line, http.StatusServiceUnavailable, ReasonRevoked)
		return
	}
	if v = c.deps.Registry.Inspect(dest, r.Method, r.URL, r.Header); !v.Allow {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	for _, h := range authHeaders {
		if h != b.Header {
			r.Header.Del(h)
		}
	}
	if status, reason := c.swap(r.Header, v.Swaps); reason != "" {
		c.deny(w, line, status, reason)
		return
	}
	line.Swapped = len(v.Swaps) > 0
	scrubber, err := c.scrubberFor(c.boundTo(dest))
	if err != nil {
		c.deny(w, line, http.StatusBadGateway, ReasonSecret)
		return
	}
	r.Body, r.ContentLength = io.NopCloser(bytes.NewReader(body)), int64(len(body))
	target := *b.Upstream
	target.Path, target.RawQuery = path.Join("/", b.Upstream.Path, rest), r.URL.RawQuery
	if g.ctx.Err() != nil {
		c.deny(w, line, http.StatusServiceUnavailable, ReasonRevoked)
		return
	}
	// Start is the final non-cancelling admission boundary, after the body and reservation.
	// Pause invalidates uploaded/prepared leases; already started responses keep draining.
	if err := modelLease.Start(); err != nil {
		c.refuseModelAdmission(w, line)
		return
	}
	meter := &gatewayMeter{c: c, price: price, hold: hold}
	c.relay(w, r.WithContext(meter.watch(r.Context())), route{dest: dest, target: &target, line: line, gen: g, local: b.Local, meter: meter}, scrubber, line)
}

// reserve holds the most the request can cost against its task and the day, waiting while
// requests already running hold the room, and returns the body with the output cap it was
// admitted with in the provider's own field. The cap is the smallest the body names, else the
// model's maximum, lowered to what the room left can pay for; more than one answer is refused.
func (c *Cell) reserve(w http.ResponseWriter, r *http.Request, g *generation, line audit.Line, op keys.Op, price llm.Price, model string, body []byte, lease *llm.TaskLease) (*llm.Hold, []byte, bool) {
	req, err := llm.ReadRequest(op.Body, model, body)
	var many *llm.ChoiceError
	switch {
	case errors.As(err, &many):
		c.refuseField(w, line, ReasonChoiceCount, many.Field)
		return nil, nil, false
	case err != nil:
		c.deny(w, line, http.StatusBadRequest, ReasonBadJSON)
		return nil, nil, false
	}
	capped := op.Cap != "" && (price.Output > 0 || lease.Snapshot())
	ask := llm.Ask{Fixed: price.Ceiling(req.Input, 0), PerToken: price.Output}
	if capped {
		ask.Tokens = price.MaxOutput
		if req.HasCap {
			ask.Tokens = min(req.Cap, price.MaxOutput)
		}
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer context.AfterFunc(g.ctx, cancel)()
	hold, err := c.deps.Budget.ReserveFor(ctx, lease, ask)
	switch {
	case err == nil:
	case g.ctx.Err() != nil:
		c.deny(w, line, http.StatusServiceUnavailable, ReasonRevoked)
		return nil, nil, false
	case r.Context().Err() != nil:
		line.Decision, line.Reason = audit.Error, ReasonClientGone
		c.record(line)
		return nil, nil, false
	default:
		c.refuseBudget(w, line, err)
		return nil, nil, false
	}
	if capped {
		if body, err = llm.WithCap(op.Cap, body, hold.Tokens()); err != nil {
			hold.Release()
			c.deny(w, line, http.StatusBadRequest, ReasonBadJSON)
			return nil, nil, false
		}
	}
	return hold, body, true
}

func (c *Cell) gatewayRoute(name string) (keys.Binding, bool) {
	if b, ok := c.deps.Local[name]; ok {
		return b, true
	}
	rec, ok := c.deps.Vault.Record(name)
	if !ok || rec.Kind != vault.KindLLM {
		return keys.Binding{}, false
	}
	b, err := keys.FromRecord(rec)
	return b, err == nil
}

func (c *Cell) refuseBudget(w http.ResponseWriter, line audit.Line, err error) {
	var exceeded *llm.ExceededError
	if !errors.As(err, &exceeded) {
		if errors.Is(err, llm.ErrNoTask) {
			c.deny(w, line, http.StatusForbidden, ReasonNoTask)
		} else {
			line.Detail = err.Error()
			c.deny(w, line, http.StatusServiceUnavailable, ReasonBudgetUnavailable)
		}
		return
	}
	reason := ReasonBudgetTask
	if exceeded.Scope == "day" {
		reason = ReasonBudgetDay
	}
	line.Decision, line.Reason, line.Status = audit.Deny, reason, http.StatusPaymentRequired
	c.record(line)
	c.announce(*exceeded)
	refusal := map[string]any{"type": "budget_exceeded", "scope": exceeded.Scope, "limitUSD": exceeded.LimitUSD, "spentUSD": exceeded.SpentUSD}
	if exceeded.NeedUSD > 0 {
		refusal["needUSD"] = exceeded.NeedUSD
	}
	w.Header().Set("X-Keyd-Reason", reason)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPaymentRequired)
	json.NewEncoder(w).Encode(map[string]any{"error": refusal})
}

// announce publishes budget.exceeded for a refusal or a crossing alike, so the daemon can stop
// the task and offer to raise its budget.
func (c *Cell) announce(e llm.ExceededError) {
	c.deps.Events.Publish(events.Event{Type: events.TypeBudget, Cell: c.cfg.CellID, Data: events.Budget{
		Scope: e.Scope, TaskID: e.TaskID, LimitUSD: e.LimitUSD, SpentUSD: e.SpentUSD,
	}})
}

// refuseField answers 400 naming the field of the body keyd refuses.
func (c *Cell) refuseField(w http.ResponseWriter, line audit.Line, reason, field string) {
	line.Decision, line.Reason, line.Status, line.Detail = audit.Deny, reason, http.StatusBadRequest, field
	c.record(line)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: "+reason+": "+field, http.StatusBadRequest)
}

// gatewayMeter reads the provider's usage from the relayed body and, when the response ends,
// settles the request's hold with what it cost and releases the rest: the usage the provider
// reported for a complete answer; the hold for a successful answer that reported none, and for a
// request the cell left before the answer's headers once keyd had begun to send it; for a stream
// cut short, the most it can have cost (its full output cap, or the bytes that reached the cell if
// more, beside what it reported), because the provider bills what it generated; for a failed
// answer, only what it reported.
type gatewayMeter struct {
	c     *Cell
	price llm.Price
	hold  *llm.Hold
	m     *llm.Meter
	ok    bool
	sent  atomic.Bool
}

// watch marks the request sent once keyd has written its headers to the provider. That comes
// before the body, so the mark is always set by the time the provider holds the whole request.
func (g *gatewayMeter) watch(ctx context.Context) context.Context {
	return httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{WroteHeaders: func() { g.sent.Store(true) }})
}

func (g *gatewayMeter) start(resp *http.Response) io.Writer {
	g.m = llm.NewMeter(resp.Header.Get("Content-Type"))
	g.ok = resp.StatusCode >= 200 && resp.StatusCode < 300
	return g.m
}

func (g *gatewayMeter) settle(l *audit.Line, out int64, clean bool) {
	if g.m == nil || g.hold == nil {
		return
	}
	u := g.m.Usage()
	switch {
	case !g.ok && !u.Reported:
		return
	case !g.ok, clean && u.Reported:
		l.CostMicroUSD, l.Usage = g.price.Cost(u), "reported"
	case clean:
		l.CostMicroUSD, l.Usage = g.hold.Amount(), "estimated"
	default:
		u.Output = max(u.Output, g.hold.Tokens(), llm.Estimate(0, out).Output)
		l.CostMicroUSD, l.Usage = max(g.hold.Amount(), g.price.Cost(u)), "estimated"
	}
	g.charge(l)
}

// left settles an interrupted relay. A received response keeps its known success/failure
// semantics. Without response headers, any request whose headers were sent may already have
// generated billable work, whether the client left, Stop canceled it, or the provider disconnected.
func (g *gatewayMeter) left(l *audit.Line) {
	if g.hold == nil {
		return
	}
	if g.m != nil {
		g.settle(l, 0, false)
		return
	}
	if !g.sent.Load() {
		return
	}
	l.CostMicroUSD, l.Usage = g.hold.Amount(), "estimated"
	g.charge(l)
}

func (g *gatewayMeter) charge(l *audit.Line) {
	crossed, err := g.hold.Settle(l.CostMicroUSD)
	if err != nil {
		log.Printf("keyd: saving request spend failed: %v", err)
	}
	for _, e := range crossed {
		g.c.announce(e)
	}
}

func transportFor(rt route) http.RoundTripper {
	if rt.local {
		return rt.gen.local
	}
	return rt.gen.tr
}

type teeCloser struct {
	io.Reader
	io.Closer
}

// Pinned dials only the listed host:port addresses. The gateway reaches model servers on the
// Mac's loopback through it, which the guard refuses everyone else.
type Pinned map[string]bool

func PinnedFor(routes map[string]keys.Binding) Pinned {
	p := Pinned{}
	for _, b := range routes {
		p[b.Upstream.Host] = true
	}
	return p
}

func (p Pinned) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if !p[address] {
		return nil, &netguard.DeniedError{Target: address, Rule: "not a local model server"}
	}
	var d net.Dialer
	return d.DialContext(ctx, network, address)
}
