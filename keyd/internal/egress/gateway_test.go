package egress

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type gatewayWorld struct {
	*world
	budget   *llm.Budget
	settings *llm.Settings
	local    map[string]keys.Binding
	cell     *Cell
	tok      string
}

// newGateway makes a brain cell holding a surrogate for an "anthropic" secret whose fake
// api.anthropic.com runs upstream, and an "lmstudio" route to localUpstream when given.
func newGateway(t *testing.T, upstream http.Handler, localUpstream http.Handler) *gatewayWorld {
	t.Helper()
	w := newWorld(t)
	dir := t.TempDir()
	settings, err := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	// The user's own limits: keyd sets none.
	if err := settings.SetLimits(llm.Limits{PerTaskUSD: 5, PerDayUSD: 20}); err != nil {
		t.Fatal(err)
	}
	budget, err := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	g := &gatewayWorld{world: w, budget: budget, settings: settings, local: map[string]keys.Binding{}}
	if upstream != nil {
		w.tlsUpstream("api.anthropic.com", upstream)
	}
	if localUpstream != nil {
		srv := httptest.NewServer(localUpstream)
		t.Cleanup(srv.Close)
		u, _ := url.Parse(srv.URL + "/v1")
		b := keys.LocalRoutes()["lmstudio"]
		b.Upstream = u
		g.local["lmstudio"] = b
	}
	w.secret(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, realValue)
	g.cell = g.open("c1", policy.Brain)
	g.tok = w.mint("c1", "anthropic")
	settings.SetModels("anthropic", []llm.Price{{Model: "claude-sonnet-5-5", Input: 3, Output: 15, MaxOutput: 300_000}})
	settings.SetModels("lmstudio", []llm.Price{{Model: "qwen/qwen3.8-27b"}})
	budget.Begin("c1", "task-1", 0)
	return g
}

func (g *gatewayWorld) open(id string, role policy.Role) *Cell {
	g.t.Helper()
	deps := g.deps()
	deps.Budget, deps.Settings, deps.Local, deps.LocalDialer = g.budget, g.settings, g.local, PinnedFor(g.local)
	p, _ := policy.ForRole(role)
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken}, deps)
	if err != nil {
		g.t.Fatal(err)
	}
	g.t.Cleanup(func() { c.Close() })
	// Legacy transport tests explicitly open their fixture's fresh closed gate.
	gate := c.current().model
	snap := gate.Snapshot()
	if _, err := gate.Resume(snap.GenerationID, snap.Epoch); err != nil {
		g.t.Fatal(err)
	}
	return c
}

func (g *gatewayWorld) post(t *testing.T, rawURL string, header http.Header, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", rawURL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := g.client(g.cell).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp, string(out)
}

func (g *gatewayWorld) key() http.Header { return http.Header{"X-Api-Key": {g.tok}} }

const sonnet = `{"model":"claude-sonnet-5-5","max_tokens":64,"messages":[]}`

func TestTheGatewaySwapsTheKeyAndChargesTheTask(t *testing.T) {
	seen := make(chan *http.Request, 1)
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000,"output_tokens":100}}`)
	}), nil)
	sub, cancel := g.events.Subscribe(8)
	defer cancel()
	header := g.key()
	header.Set("Authorization", "Bearer something-the-cell-found")
	header.Set("Cookie", "session=x")
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", header, sonnet)
	if resp.StatusCode != 200 || !strings.Contains(body, `"text":"ok"`) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	r := <-seen
	if r.URL.Path != "/v1/messages" || r.Header.Get("X-Api-Key") != realValue || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
		t.Fatalf("upstream saw %s %v", r.URL.Path, r.Header)
	}
	l := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Decision == audit.Allow })
	if l.Route != "anthropic" || l.Model != "claude-sonnet-5-5" || l.CostMicroUSD != 4500 || l.Usage != "reported" ||
		l.Host != "api.anthropic.com" || l.Path != "/v1/messages" || !l.Swapped || l.SecretID != "anthropic" {
		t.Fatalf("audit %+v", l)
	}
	if info, _ := g.budget.Task("c1"); info.SpentUSD != 0.0045 {
		t.Fatalf("task spent %v", info.SpentUSD)
	}
	got := map[string]events.Event{}
	for len(got) < 2 {
		e := <-sub
		got[e.Type] = e
	}
	if ku := got[events.TypeKeyUse].Data.(events.KeyUse); ku.SecretID != "anthropic" || ku.Host != "api.anthropic.com" || ku.Decision != "allow" {
		t.Fatalf("event %+v", got[events.TypeKeyUse])
	}
	spend := got[events.TypeSpend].Data.(events.Spend)
	if spend != (events.Spend{TaskID: spend.TaskID, Route: "anthropic", Model: "claude-sonnet-5-5", CostUSD: 0.0045, TaskSpentUSD: 0.0045, TaskLimitUSD: 5, DaySpentUSD: 0.0045, DayLimitUSD: 20}) || spend.TaskID == "" {
		t.Fatalf("spend %+v", spend)
	}
}

func TestACostTheProviderStatesIsWhatTheTaskIsCharged(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":1000,"output_tokens":100,"cost":0.0021}}`)
	}), nil)
	sub, cancel := g.events.Subscribe(8)
	defer cancel()
	if resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	l := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Decision == audit.Allow })
	if l.CostMicroUSD != 2100 || l.Usage != "billed" {
		t.Fatalf("audit %+v", l)
	}
	for {
		if e := <-sub; e.Type == events.TypeSpend {
			if spend := e.Data.(events.Spend); !spend.Billed || spend.CostUSD != 0.0021 {
				t.Fatalf("spend %+v", spend)
			}
			return
		}
	}
}

func TestAStreamedAnswerIsMeteredAndScrubbed(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":2000,\"output_tokens\":1}}}\n\n")
		rw.(http.Flusher).Flush()
		io.WriteString(rw, "event: content_block_delta\ndata: {\"delta\":{\"text\":\"your key is "+realValue+"\"}}\n\n")
		io.WriteString(rw, "event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":200}}\n\n")
	}), nil)
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != 200 || strings.Contains(body, realValue) || !strings.Contains(body, "your key is "+g.tok) {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	l := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Decision == audit.Allow })
	if l.CostMicroUSD != 2000*3+200*15 {
		t.Fatalf("cost %d", l.CostMicroUSD)
	}
}

func TestTheGatewayRefuses(t *testing.T) {
	var hits atomic.Int32
	g := newGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
	desktop := g.open("c2", policy.Desktop)
	noTask := g.open("c3", policy.Brain)
	tokNoTask := g.mint("c3", "anthropic")
	cases := []struct {
		name   string
		cell   *Cell
		url    string
		header http.Header
		body   string
		status int
		reason string
	}{
		{"unknown route", g.cell, "http://llm.ldot/mistral/chat/completions", g.key(), sonnet, 404, ReasonRouteUnknown},
		{"operation not listed", g.cell, "http://llm.ldot/anthropic/files", g.key(), sonnet, 403, ReasonOpNotAllowed},
		{"dot segments", g.cell, "http://llm.ldot/anthropic/messages/../messages", g.key(), sonnet, 403, ReasonOpNotAllowed},
		{"no surrogate", g.cell, "http://llm.ldot/anthropic/messages", nil, sonnet, 403, ReasonSurrogateMissing},
		{"surrogate in the wrong header", g.cell, "http://llm.ldot/anthropic/messages", http.Header{"Authorization": {"Bearer " + g.tok}}, sonnet, 403, "misplaced-surrogate"},
		{"no task", noTask, "http://llm.ldot/anthropic/messages", http.Header{"X-Api-Key": {tokNoTask}}, sonnet, 403, ReasonNoTask},
		{"model not allowed", g.cell, "http://llm.ldot/anthropic/messages", g.key(), `{"model":"claude-opus-5-5"}`, 403, ReasonModelNotAllowed},
		{"model named twice", g.cell, "http://llm.ldot/anthropic/messages", g.key(), `{"model":"claude-sonnet-5-5","model":"claude-opus-5-5"}`, 400, ReasonBadJSON},
		{"no model", g.cell, "http://llm.ldot/anthropic/messages", g.key(), `{"messages":[]}`, 400, ReasonModelMissing},
		{"desktop cells have no gateway", desktop, "http://llm.ldot/anthropic/messages", nil, sonnet, 403, policy.ReasonHostDenied},
		{"a desktop cell with the brain's surrogate", desktop, "http://llm.ldot/anthropic/messages", g.key(), sonnet, 403, "misplaced-surrogate"},
		{"upgrade", g.cell, "http://llm.ldot/anthropic/messages", http.Header{"X-Api-Key": {g.tok}, "Connection": {"Upgrade"}, "Upgrade": {"websocket"}}, sonnet, 403, ReasonUpgrade},
	}
	for _, c := range cases {
		req, _ := http.NewRequest("POST", c.url, strings.NewReader(c.body))
		for k, vs := range c.header {
			req.Header[k] = vs
		}
		resp, err := g.client(c.cell).Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != c.status || resp.Header.Get("X-Keyd-Reason") != c.reason {
			t.Errorf("%s: %d %q, want %d %q", c.name, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), c.status, c.reason)
		}
	}
	big := `{"model":"claude-sonnet-5-5","pad":"` + strings.Repeat("x", maxGatewayBody) + `"}`
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), big); resp.StatusCode != 413 {
		t.Errorf("oversized body: %d", resp.StatusCode)
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("the provider was reached %d times", n)
	}
}

func TestWithoutTheUsersLimitsNoTaskStopsForCost(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":1000000,"output_tokens":200000}}`)
	}), nil)
	if err := g.settings.SetLimits(llm.Limits{}); err != nil {
		t.Fatal(err)
	}
	if err := g.budget.Begin("c1", "task-2", 0); err != nil {
		t.Fatal(err)
	}
	for range 4 {
		if resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 200 {
			t.Fatalf("%d %s", resp.StatusCode, body)
		}
	}
	if info, _ := g.budget.Task("c1"); info.LimitUSD != 0 || info.SpentUSD != 24 {
		t.Fatalf("task %+v", info)
	}
}

func TestBudgetsRefuseOnceReached(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":1000000,"output_tokens":200000}}`)
	}), nil)
	sub, cancel := g.events.Subscribe(16)
	defer cancel()
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 200 {
		t.Fatalf("first request: %d", resp.StatusCode)
	}
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	var refusal struct {
		Error struct {
			Type     string  `json:"type"`
			Scope    string  `json:"scope"`
			LimitUSD float64 `json:"limitUSD"`
			SpentUSD float64 `json:"spentUSD"`
		} `json:"error"`
	}
	json.Unmarshal([]byte(body), &refusal)
	if resp.StatusCode != http.StatusPaymentRequired || resp.Header.Get("X-Keyd-Reason") != ReasonBudgetTask ||
		refusal.Error.Type != "budget_exceeded" || refusal.Error.LimitUSD != 5 || refusal.Error.SpentUSD != 6 {
		t.Fatalf("%d %s", resp.StatusCode, body)
	}
	found := false
	for !found {
		select {
		case e := <-sub:
			if b, ok := e.Data.(events.Budget); ok && e.Type == events.TypeBudget && b.Scope == "task" && b.TaskID == "task-1" {
				found = true
			}
		case <-time.After(time.Second):
			t.Fatal("no budget.exceeded event")
		}
	}
	g.budget.Begin("c1", "task-1", 50)
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 200 {
		t.Fatalf("after raising the budget: %d", resp.StatusCode)
	}
	if err := g.settings.SetLimits(llm.Limits{PerTaskUSD: 10, PerDayUSD: 10}); err != nil {
		t.Fatal(err)
	}
	g.budget.Begin("c1", "task-2", 0)
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 402 || resp.Header.Get("X-Keyd-Reason") != ReasonBudgetDay {
		t.Fatalf("over the day: %d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
}

func TestAnUpstreamFailureAnswers502(t *testing.T) {
	g := newGateway(t, nil, nil)
	ln, _ := net.Listen("tcp4", "127.0.0.1:0")
	addr := ln.Addr().String()
	ln.Close()
	g.publish("api.anthropic.com", "443", addr, true)
	if resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet); resp.StatusCode != 502 || resp.Header.Get("X-Keyd-Reason") != ReasonUpstream {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
	}
	if info, _ := g.budget.Task("c1"); info.SpentUSD != 0 {
		t.Fatalf("a failed request was charged %v", info.SpentUSD)
	}
}

func TestACutStreamIsChargedTheMostItCanHaveCost(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":1}}}\n\n")
		io.WriteString(rw, "data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n")
		rw.(http.Flusher).Flush()
		panic(http.ErrAbortHandler)
	}), nil)
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(`{"model":"claude-sonnet-5-5","max_tokens":1000,"messages":[]}`))
	req.Header = g.key()
	resp, err := g.client(g.cell).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(resp.Body)
	resp.Body.Close()
	if err == nil {
		t.Fatal("the stream ended cleanly after the provider failed")
	}
	l := g.waitLine(reasonIs(ReasonAborted))
	// The provider may have written up to the cap before it failed, past the few bytes relayed.
	price := llm.Price{Input: 3, Output: 15}
	want := price.Cost(llm.Usage{Input: 1000, Output: 1000})
	if l.CostMicroUSD != want || llm.Estimate(0, l.BytesOut).Output >= 1000 || l.Usage != "estimated" {
		t.Fatalf("audit %+v: charged %d, want %d (reported alone: %d)", l, l.CostMicroUSD, want, price.Cost(llm.Usage{Input: 1000, Output: 1}))
	}
	if info, _ := g.budget.Task("c1"); info.SpentUSD != float64(want)/1e6 {
		t.Fatalf("task spent %v", info.SpentUSD)
	}
}

func TestARequestInspectedBeforeStopNeverReachesTheProvider(t *testing.T) {
	reached := make(chan string, 1)
	g := newGateway(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		reached <- r.Header.Get("X-Api-Key")
	}), nil)
	body, upload := io.Pipe()
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", body)
	req.Header = g.key()
	answered := make(chan *http.Response, 1)
	go func() {
		resp, err := g.client(g.cell).Do(req)
		if err != nil {
			resp = &http.Response{StatusCode: 0, Header: http.Header{}, Body: http.NoBody}
		}
		answered <- resp
	}()
	io.WriteString(upload, `{"model":"claude-sonnet-5-5",`)
	time.Sleep(300 * time.Millisecond)
	// Stop, as Manager.Revoke does it for this cell, while keyd reads the body.
	g.registry.RevokeCell("c1")
	g.cell.Revoke()
	io.WriteString(upload, `"max_tokens":8,"messages":[]}`)
	upload.Close()
	resp := <-answered
	resp.Body.Close()
	select {
	case key := <-reached:
		t.Fatalf("the provider was reached after Stop, with X-Api-Key %q", key)
	default:
	}
	// 503 revoked, not 403 unknown-surrogate: keyd inspected the request before Stop.
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != ReasonRevoked {
		t.Fatalf("%d %q, want 503 %q", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), ReasonRevoked)
	}
}

// fourFifty may produce 300,000 tokens, $4.50 at the test price.
const fourFifty = `{"model":"claude-sonnet-5-5","max_tokens":300000,"messages":[]}`

// billTheCap answers each request, once release is closed, with as much output as its max_tokens
// allows, keeping in most the largest number of requests it held at once.
func billTheCap(release <-chan struct{}, running, most *atomic.Int32) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		n := running.Add(1)
		defer running.Add(-1)
		for m := most.Load(); n > m && !most.CompareAndSwap(m, n); m = most.Load() {
		}
		var body struct {
			MaxTokens int64 `json:"max_tokens"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		<-release
		rw.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(rw, `{"usage":{"input_tokens":20,"output_tokens":%d}}`, body.MaxTokens)
	})
}

// send posts body to the anthropic route from c with surrogate tok and returns the status; it is
// safe off the test's goroutine.
func (g *gatewayWorld) send(c *Cell, tok, body string) int {
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", tok)
	resp, err := g.client(c).Do(req)
	if err != nil {
		return 0
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

// inParallel starts every send at once, lets the provider answer after a moment and counts the
// statuses.
func inParallel(release chan struct{}, sends []func() int) map[int]int {
	statuses := make(chan int, len(sends))
	var wg sync.WaitGroup
	for _, send := range sends {
		wg.Go(func() { statuses <- send() })
	}
	time.Sleep(300 * time.Millisecond)
	close(release)
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for s := range statuses {
		counts[s]++
	}
	return counts
}

func TestParallelRequestsCannotOvershootTheTask(t *testing.T) {
	release := make(chan struct{})
	var running, most atomic.Int32
	g := newGateway(t, billTheCap(release, &running, &most), nil)
	sends := make([]func() int, 20)
	for i := range sends {
		sends[i] = func() int { return g.send(g.cell, g.tok, fourFifty) }
	}
	counts := inParallel(release, sends)
	info, _ := g.budget.Task("c1")
	// The second runs with the room the first left, its cap lowered to fit.
	if info.SpentUSD > info.LimitUSD || most.Load() != 1 || counts[200] != 2 || counts[402] != 18 {
		t.Fatalf("%d at once; statuses %v; the task spent $%.6f of $%.2f", most.Load(), counts, info.SpentUSD, info.LimitUSD)
	}
}

func TestParallelRequestsFromManyCellsCannotOvershootTheDay(t *testing.T) {
	release := make(chan struct{})
	var running, most atomic.Int32
	g := newGateway(t, billTheCap(release, &running, &most), nil)
	if err := g.settings.SetLimits(llm.Limits{PerTaskUSD: 5, PerDayUSD: 10}); err != nil {
		t.Fatal(err)
	}
	sends := []func() int{func() int { return g.send(g.cell, g.tok, fourFifty) }}
	for _, id := range []string{"c2", "c3", "c4", "c5"} {
		c := g.open(id, policy.Brain)
		tok := g.mint(id, "anthropic")
		g.budget.Begin(id, "task-"+id, 0)
		sends = append(sends, func() int { return g.send(c, tok, fourFifty) })
	}
	counts := inParallel(release, sends)
	if _, day := g.budget.Day(); day > 10 || counts[200] != 3 || counts[402] != 2 {
		t.Fatalf("statuses %v; the day spent $%.6f of $10", counts, day)
	}
}

func TestAClientDisconnectStopsTheProvider(t *testing.T) {
	aborted := make(chan struct{})
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {}\n\n")
		rw.(http.Flusher).Flush()
		<-r.Context().Done()
		close(aborted)
	}), nil)
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://llm.ldot/anthropic/messages", strings.NewReader(sonnet))
	req.Header = g.key()
	resp, err := g.client(g.cell).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Read(make([]byte, 16))
	cancel()
	resp.Body.Close()
	select {
	case <-aborted:
	case <-time.After(3 * time.Second):
		t.Fatal("the provider kept generating after the client left")
	}
	// keyd charges the request before it writes the line, so the test ends after the charge.
	g.waitLine(reasonIs(ReasonClientGone))
}

// leave sends body from the cell and hangs up once arrived says keyd has passed it on.
func (g *gatewayWorld) leave(t *testing.T, body string, arrived <-chan struct{}) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, "POST", "http://llm.ldot/anthropic/messages", strings.NewReader(body))
	req.Header = g.key()
	gone := make(chan struct{})
	go func() {
		defer close(gone)
		if resp, err := g.client(g.cell).Do(req); err == nil {
			resp.Body.Close()
		}
	}()
	select {
	case <-arrived:
	case <-time.After(3 * time.Second):
		t.Fatal("keyd never passed the request on")
	}
	cancel()
	<-gone
}

func TestACellThatLeavesBeforeTheAnswerIsChargedItsHold(t *testing.T) {
	// A whole answer's headers come when it is generated; the provider bills the tokens it made
	// before keyd cancels it.
	reached := make(chan struct{}, 1)
	g := newGateway(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		reached <- struct{}{}
		<-r.Context().Done()
	}), nil)
	g.leave(t, fourFifty, reached)
	l := g.waitLine(reasonIs(ReasonClientGone))
	hold := llm.Price{Input: 3, Output: 15}.Ceiling(llm.Estimate(int64(len(fourFifty)), 0).Input, 300_000)
	if info, _ := g.budget.Task("c1"); l.CostMicroUSD != hold || l.Usage != "estimated" || info.SpentUSD != float64(hold)/1e6 {
		t.Fatalf("audit %+v, task spent $%.6f; want the hold, %d", l, info.SpentUSD, hold)
	}

	// A request keyd has not begun to send, its connection still opening, costs nothing.
	g = newGateway(t, nil, nil)
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done, dialed := make(chan struct{}), make(chan struct{}, 1)
	t.Cleanup(func() { close(done); ln.Close() })
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		dialed <- struct{}{} // and never answers the TLS handshake
		<-done
	}()
	g.publish("api.anthropic.com", "443", ln.Addr().String(), true)
	g.leave(t, fourFifty, dialed)
	l = g.waitLine(reasonIs(ReasonClientGone))
	if info, _ := g.budget.Task("c1"); l.CostMicroUSD != 0 || info.SpentUSD != 0 {
		t.Fatalf("audit %+v, task spent $%.6f; want nothing", l, info.SpentUSD)
	}
}

func TestLocalRoutesReachOnlyTheirServer(t *testing.T) {
	seen := make(chan *http.Request, 1)
	g := newGateway(t, nil, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	}))
	resp, _ := g.post(t, "http://llm.ldot/lmstudio/chat/completions", http.Header{"Authorization": {"Bearer lm-studio"}}, `{"model":"qwen/qwen3.8-27b"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("%d", resp.StatusCode)
	}
	if r := <-seen; r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "" {
		t.Fatalf("local server saw %s %v", r.URL.Path, r.Header)
	}
	l := g.waitLine(func(l audit.Line) bool { return l.Route == "lmstudio" && l.Decision == audit.Allow })
	if l.CostMicroUSD != 0 || l.SecretID != "" {
		t.Fatalf("audit %+v", l)
	}
	if _, err := PinnedFor(g.local).DialContext(context.Background(), "tcp", "127.0.0.1:1"); !errors.As(err, new(*netguard.DeniedError)) {
		t.Fatalf("pinned dialer reached another address: %v", err)
	}
}

func TestGeminiNamesItsModelInThePath(t *testing.T) {
	seen := make(chan *http.Request, 1)
	g := newGateway(t, nil, nil)
	g.tlsUpstream("generativelanguage.googleapis.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Clone(context.Background())
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {\"usageMetadata\":{\"promptTokenCount\":100,\"candidatesTokenCount\":10}}\n\n")
	}))
	g.secret(vault.Record{ID: "gemini", Kind: vault.KindLLM, Provider: "google"}, realValue)
	tok := g.mint("c1", "gemini")
	g.settings.SetModels("gemini", []llm.Price{{Model: "gemini-3.6-flash", Input: 0.5, Output: 3, MaxOutput: 65_536}})
	resp, _ := g.post(t, "http://llm.ldot/gemini/models/gemini-3.6-flash:streamGenerateContent?alt=sse", http.Header{"X-Goog-Api-Key": {tok}}, `{"contents":[]}`)
	if resp.StatusCode != 200 {
		t.Fatalf("%d", resp.StatusCode)
	}
	r := <-seen
	if r.URL.Path != "/v1beta/models/gemini-3.6-flash:streamGenerateContent" || r.URL.RawQuery != "alt=sse" || r.Header.Get("X-Goog-Api-Key") != realValue {
		t.Fatalf("upstream saw %s?%s %v", r.URL.Path, r.URL.RawQuery, r.Header)
	}
	if resp, _ := g.post(t, "http://llm.ldot/gemini/models/gemini-3.6-pro:generateContent", http.Header{"X-Goog-Api-Key": {tok}}, `{}`); resp.StatusCode != 403 {
		t.Fatalf("unlisted gemini model: %d", resp.StatusCode)
	}
}

func TestAnAnswerWithoutUsageIsChargedItsHold(t *testing.T) {
	status := atomic.Int32{}
	status.Store(200)
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.WriteHeader(int(status.Load()))
		io.WriteString(rw, strings.Repeat("x", 300))
	}), nil)
	g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	l := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Status == 200 })
	want := llm.Price{Input: 3, Output: 15}.Ceiling(llm.Estimate(int64(len(sonnet)), 0).Input, 64)
	if l.Usage != "estimated" || l.CostMicroUSD != want {
		t.Fatalf("audit %+v, want the hold, %d", l, want)
	}
	status.Store(400)
	g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	l = g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Status == 400 })
	if l.CostMicroUSD != 0 || l.Usage != "" {
		t.Fatalf("a failed answer was charged: %+v", l)
	}
}

// llmRoute adds an LLM secret for provider at a fake upstream host, mints its surrogate for each
// cell, and allows model at the test price with a 300,000-token maximum output.
func (g *gatewayWorld) llmRoute(id, provider, baseURL, host, model string, upstream http.Handler, cells ...string) map[string]string {
	g.t.Helper()
	g.tlsUpstream(host, upstream)
	g.secret(vault.Record{ID: id, Kind: vault.KindLLM, Provider: provider, BaseURL: baseURL}, realValue)
	if err := g.settings.SetModels(id, []llm.Price{{Model: model, Input: 3, Output: 15, MaxOutput: 300_000}}); err != nil {
		g.t.Fatal(err)
	}
	toks := map[string]string{}
	for _, c := range cells {
		toks[c] = g.mint(c, id)
	}
	return toks
}

// call posts body to rawURL from c and returns the status and the body; it is safe off the
// test's goroutine.
func (g *gatewayWorld) call(c *Cell, rawURL string, header http.Header, body string) (int, string) {
	req, _ := http.NewRequest("POST", rawURL, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, vs := range header {
		req.Header[k] = vs
	}
	resp, err := g.client(c).Do(req)
	if err != nil {
		return 0, err.Error()
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(out)
}

// generous answers, once release is closed, like a provider that writes all it may: the cap it
// reads in its own field (a dotted path), or 300,000 tokens ($4.50 at the test price) when that is
// absent or null, times each count of answers it reads (a list counts its elements).
func generous(capField string, counts []string, release <-chan struct{}) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		read := func(path string) (float64, bool) {
			var v any = body
			for _, k := range strings.Split(path, ".") {
				m, _ := v.(map[string]any)
				v = m[k]
			}
			if list, ok := v.([]any); ok {
				return float64(len(list)), true
			}
			n, ok := v.(float64)
			return n, ok
		}
		out, ok := read(capField)
		if !ok {
			out = 300_000
		}
		for _, field := range counts {
			if n, ok := read(field); ok {
				out *= n
			}
		}
		<-release
		rw.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, ":generateContent") {
			fmt.Fprintf(rw, `{"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":%d}}`, int64(out))
			return
		}
		fmt.Fprintf(rw, `{"usage":{"prompt_tokens":20,"completion_tokens":%d}}`, int64(out))
	})
}

// shape is a request that hides what it can cost from a gateway that trusts its body. With
// refused set keyd answers 400 naming that field; with fills, keyd sets the cap, and the provider
// writes all the room allows.
type shape struct {
	name, route, provider, baseURL, host, path, header, body string
	capField                                                 string
	counts                                                   []string
	refused                                                  string
	fills                                                    bool
}

var shapes = []shape{
	{"a null cap", "openai", "openai", "", "api.openai.com", "chat/completions", "Authorization",
		`{"model":"m","max_completion_tokens":null,"messages":[]}`, "max_completion_tokens", []string{"n"}, "", true},
	{"a null cap in Gemini's config", "gemini", "google", "", "generativelanguage.googleapis.com", "models/m:generateContent", "X-Goog-Api-Key",
		`{"contents":[],"generationConfig":{"maxOutputTokens":null}}`, "generationConfig.maxOutputTokens", []string{"generationConfig.candidateCount"}, "", true},
	{"n", "openai", "openai", "", "api.openai.com", "chat/completions", "Authorization",
		`{"model":"m","max_completion_tokens":2000,"n":128,"messages":[]}`, "max_completion_tokens", []string{"n"}, "n", false},
	{"best_of", "openai", "openai", "", "api.openai.com", "completions", "Authorization",
		`{"model":"m","prompt":"x","max_tokens":10000,"best_of":20}`, "max_tokens", []string{"best_of"}, "best_of", false},
	{"candidateCount", "gemini", "google", "", "generativelanguage.googleapis.com", "models/m:generateContent", "X-Goog-Api-Key",
		`{"contents":[],"generationConfig":{"maxOutputTokens":30000,"candidateCount":8}}`, "generationConfig.maxOutputTokens", []string{"generationConfig.candidateCount"}, "candidateCount", false},
	// The completions API answers each prompt of a list under the one cap.
	{"a prompt list", "openai", "openai", "", "api.openai.com", "completions", "Authorization",
		`{"model":"m","prompt":["x","y","z"],"max_tokens":10000}`, "max_tokens", []string{"prompt"}, "prompt", false},
	// The cell's one-token cap, in a field the server ignores, becomes keyd's cap in max_tokens.
	{"a cap the server ignores", "compat", "openai-compatible", "https://llm.example.test/v1", "llm.example.test", "chat/completions", "Authorization",
		`{"model":"m","max_output_tokens":1,"messages":[]}`, "max_tokens", []string{"n"}, "", false},
}

func TestNoRequestShapeOvershootsTheBudget(t *testing.T) {
	for _, s := range shapes {
		for _, cells := range []int{1, 5} {
			t.Run(fmt.Sprintf("%s from %d cells", s.name, cells), func(t *testing.T) {
				t.Parallel()
				release := make(chan struct{})
				g := newGateway(t, nil, nil)
				ids, cs := []string{"c1"}, []*Cell{g.cell}
				for i := 2; i <= cells; i++ {
					id := fmt.Sprintf("c%d", i)
					cs = append(cs, g.open(id, policy.Brain))
					g.budget.Begin(id, "task-"+id, 0)
					ids = append(ids, id)
				}
				toks := g.llmRoute(s.route, s.provider, s.baseURL, s.host, "m", generous(s.capField, s.counts, release), ids...)
				header := func(id string) http.Header {
					if s.header == "Authorization" {
						return http.Header{"Authorization": {"Bearer " + toks[id]}}
					}
					return http.Header{s.header: {toks[id]}}
				}
				target := "http://llm.ldot/" + s.route + "/" + s.path
				if s.refused != "" {
					if status, body := g.call(g.cell, target, header("c1"), s.body); status != 400 || body != "keyd: "+ReasonChoiceCount+": "+s.refused+"\n" {
						t.Fatalf("%d %q", status, body)
					}
				}
				sends := make([]func() int, 20)
				for i := range sends {
					c, id := cs[i%cells], ids[i%cells]
					sends[i] = func() int {
						status, _ := g.call(c, target, header(id), s.body)
						return status
					}
				}
				counts := inParallel(release, sends)
				for _, id := range ids {
					if info, _ := g.budget.Task(id); info.SpentUSD > info.LimitUSD {
						t.Errorf("statuses %v; %s spent $%.2f of $%.2f", counts, id, info.SpentUSD, info.LimitUSD)
					}
				}
				if _, day := g.budget.Day(); day > 20 {
					t.Errorf("statuses %v; the day spent $%.6f of $20", counts, day)
				}
				_, day := g.budget.Day()
				switch {
				case s.refused != "" && counts[400] != 20:
					t.Errorf("statuses %v, want 20 refusals naming %s", counts, s.refused)
				case s.fills && (counts[200] == 0 || day < min(4.99*float64(cells), 19.99)):
					t.Errorf("statuses %v; the day spent $%.2f, not all the room allowed", counts, day)
				case s.refused == "" && !s.fills && counts[200] != 20:
					t.Errorf("statuses %v, want 20 answers capped as the cell asked", counts)
				}
			})
		}
	}
}

func TestTheGatewayWritesTheCapInTheProvidersField(t *testing.T) {
	seen := make(chan map[string]any, 1)
	record := http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		seen <- body
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"prompt_tokens":10,"completion_tokens":10}}`)
	})
	g := newGateway(t, record, nil)
	toks := map[string]http.Header{"anthropic": g.key()}
	for _, r := range []struct{ id, provider, baseURL, host, header string }{
		{"openai", "openai", "", "api.openai.com", "Authorization"},
		{"compat", "openai-compatible", "https://llm.example.test/v1", "llm.example.test", "Authorization"},
		{"gemini", "google", "", "generativelanguage.googleapis.com", "X-Goog-Api-Key"},
	} {
		tok := g.llmRoute(r.id, r.provider, r.baseURL, r.host, "m", record, "c1")["c1"]
		toks[r.id] = http.Header{r.header: {tok}}
		if r.header == "Authorization" {
			toks[r.id] = http.Header{r.header: {"Bearer " + tok}}
		}
	}
	cases := []struct {
		name, route, path, body, field string
		want                           float64
	}{
		{"anthropic, no cap", "anthropic", "messages", `{"model":"claude-sonnet-5-5","messages":[]}`, "max_tokens", 300_000},
		{"anthropic, null and another field", "anthropic", "messages", `{"model":"claude-sonnet-5-5","max_tokens":null,"max_output_tokens":64,"messages":[]}`, "max_tokens", 64},
		{"openai chat, null", "openai", "chat/completions", `{"model":"m","max_completion_tokens":null,"messages":[]}`, "max_completion_tokens", 300_000},
		{"openai chat, the older field", "openai", "chat/completions", `{"model":"m","max_tokens":512,"messages":[]}`, "max_completion_tokens", 512},
		{"openai responses, no cap", "openai", "responses", `{"model":"m","input":"hi"}`, "max_output_tokens", 300_000},
		{"openai completions, a string", "openai", "completions", `{"model":"m","prompt":"hi","max_tokens":"64"}`, "max_tokens", 300_000},
		{"openai-compatible, a field it ignores", "compat", "chat/completions", `{"model":"m","max_output_tokens":1,"messages":[]}`, "max_tokens", 1},
		{"gemini, null", "gemini", "models/m:generateContent", `{"contents":[],"generationConfig":{"maxOutputTokens":null,"temperature":1}}`, "generationConfig.maxOutputTokens", 300_000},
		{"gemini, the proto name", "gemini", "models/m:streamGenerateContent", `{"contents":[],"generation_config":{"max_output_tokens":2048}}`, "generation_config.maxOutputTokens", 2048},
	}
	for _, c := range cases {
		if status, body := g.call(g.cell, "http://llm.ldot/"+c.route+"/"+c.path, toks[c.route], c.body); status != 200 {
			t.Fatalf("%s: %d %s", c.name, status, body)
		}
		got := <-seen
		camel, _ := got["generationConfig"].(map[string]any)
		snake, _ := got["generation_config"].(map[string]any)
		caps := 0
		for _, object := range []map[string]any{got, camel, snake} {
			for k := range object {
				if f := strings.ToLower(strings.ReplaceAll(k, "_", "")); f == "maxtokens" || f == "maxcompletiontokens" || f == "maxoutputtokens" {
					caps++
				}
			}
		}
		value := got[c.field]
		if parent, field, nested := strings.Cut(c.field, "."); nested {
			config, _ := got[parent].(map[string]any)
			value = config[field]
		}
		if caps != 1 || value != c.want {
			t.Errorf("%s: the provider read %v in %s, with %d caps in all: %v", c.name, value, c.field, caps, got)
		}
	}
}

// chatBody asks a chat-completions route for a streamed answer of at most 64 tokens.
const chatBody = `{"model":"m","max_tokens":64,"messages":[],"stream":true}`

// Part 5a's first-class bearer providers (P5a-R31): each preset sends the surrogate's real key as a
// bearer token to its own fixed host and base path, lists only the operation its official package
// calls, and has its usage, in its own dialect, charged to the task. DeepSeek's base URL has no
// path, so the upstream path is joined under "/".
func TestEachFirstClassBearerProviderHasItsOwnRoute(t *testing.T) {
	chat := func(last string) string {
		return "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"ok\"}}]}\n\n" +
			"data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]," + last + "}\n\ndata: [DONE]\n\n"
	}
	const usage = `{"prompt_tokens":1200,"completion_tokens":80}`
	cases := []struct {
		provider, host, op, upstreamPath, other, body, stream string
	}{
		{"xai", "api.x.ai", "responses", "/v1/responses", "chat/completions",
			`{"model":"m","input":"hi","max_output_tokens":64,"stream":true}`,
			"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1200,\"output_tokens\":80}}}\n\n"},
		{"mistral", "api.mistral.ai", "chat/completions", "/v1/chat/completions", "responses", chatBody, chat(`"usage":` + usage)},
		{"deepseek", "api.deepseek.com", "chat/completions", "/chat/completions", "responses", chatBody, chat(`"usage":` + usage)},
		{"groq", "api.groq.com", "chat/completions", "/openai/v1/chat/completions", "responses", chatBody, chat(`"x_groq":{"id":"req_1","usage":` + usage + `}`)},
		{"openrouter", "openrouter.ai", "chat/completions", "/api/v1/chat/completions", "completions", chatBody, chat(`"usage":` + usage)},
	}
	for _, c := range cases {
		t.Run(c.provider, func(t *testing.T) {
			seen := make(chan *http.Request, 4)
			g := newGateway(t, nil, nil)
			tok := g.llmRoute(c.provider, c.provider, "", c.host, "m", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
				seen <- r.Clone(context.Background())
				rw.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(rw, c.stream)
			}), "c1")["c1"]
			bearer := http.Header{"Authorization": {"Bearer " + tok}}
			resp, body := g.post(t, "http://llm.ldot/"+c.provider+"/"+c.op, bearer, c.body)
			if resp.StatusCode != 200 || !strings.Contains(body, "1200") {
				t.Fatalf("%d %s", resp.StatusCode, body)
			}
			r := <-seen
			if r.URL.Path != c.upstreamPath || r.Header.Get("Authorization") != "Bearer "+realValue {
				t.Fatalf("upstream saw %s %v", r.URL.Path, r.Header)
			}
			l := g.waitLine(func(l audit.Line) bool {
				return l.Mode == "gateway" && l.Decision == audit.Allow && l.Route == c.provider
			})
			if l.Host != c.host || l.Path != c.upstreamPath || l.SecretID != c.provider || !l.Swapped ||
				l.Usage != "reported" || l.CostMicroUSD != 1200*3+80*15 {
				t.Fatalf("audit %+v", l)
			}
			if info, _ := g.budget.Task("c1"); info.SpentUSD != 0.0048 {
				t.Fatalf("task spent %v", info.SpentUSD)
			}
			if resp, _ := g.post(t, "http://llm.ldot/"+c.provider+"/"+c.other, bearer, chatBody); resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonOpNotAllowed {
				t.Errorf("%s, which the package never calls: %d %q", c.other, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
			}
			// OpenRouter's fallback list could answer with a model off the allowlist.
			fallback := `{"model":"m","models":["m","pricier"],"messages":[]}`
			if status, body := g.call(g.cell, "http://llm.ldot/"+c.provider+"/"+c.op, bearer, fallback); status != 400 || body != "keyd: "+ReasonChoiceCount+": models\n" {
				t.Errorf("a models list: %d %q", status, body)
			}
			select {
			case r := <-seen:
				t.Fatalf("a refused request reached the provider at %s", r.URL.Path)
			default:
			}
		})
	}
}

// No price, no route (Part 5a's amendment, P5a-R32): a model priced at nothing both ways never
// reaches a provider that bills, whether a router, a free model or a mistake in the prices; a
// local server's free model still runs (TestLocalRoutesReachOnlyTheirServer).
func TestAnUnpricedModelNeverRunsOnAPaidRoute(t *testing.T) {
	var hits atomic.Int32
	provider := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) })
	g := newGateway(t, provider, nil)
	tok := g.llmRoute("openrouter", "openrouter", "", "openrouter.ai", "m", provider, "c1")["c1"]
	if err := g.settings.SetModels("openrouter", []llm.Price{{Model: "openrouter/auto"}, {Model: "meta-llama/llama-4-maverick:free"}}); err != nil {
		t.Fatal(err)
	}
	if err := g.settings.SetModels("anthropic", []llm.Price{{Model: "claude-sonnet-5-5", Input: 3, Output: 15, MaxOutput: 300_000}, {Model: "claude-unpriced"}}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct{ route, header, model string }{
		{"openrouter", "Bearer " + tok, "openrouter/auto"},
		{"openrouter", "Bearer " + tok, "meta-llama/llama-4-maverick:free"},
		{"anthropic", "", "claude-unpriced"},
	} {
		header := g.key()
		path := "messages"
		if c.route == "openrouter" {
			header, path = http.Header{"Authorization": {c.header}}, "chat/completions"
		}
		resp, _ := g.post(t, "http://llm.ldot/"+c.route+"/"+path, header, `{"model":"`+c.model+`","messages":[]}`)
		if resp.StatusCode != 403 || resp.Header.Get("X-Keyd-Reason") != ReasonModelUnpriced {
			t.Errorf("%s on %s: %d %q", c.model, c.route, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"))
		}
	}
	if n := hits.Load(); n != 0 {
		t.Fatalf("an unpriced model reached the provider %d times", n)
	}
}

// screenshot is a 1280x800 PNG padded to 450 KB, the size review 2 measured, in base64.
func screenshot(t *testing.T) string {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewGray(image.Rect(0, 0, 1280, 800))); err != nil {
		t.Fatal(err)
	}
	b.Write(make([]byte, 450_000-b.Len()))
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

func TestScreenshotsDoNotStopATaskEarly(t *testing.T) {
	// Review 2's numbers: five 1280x800 screenshots of 450 KB with max_tokens 4096, billed at the test
	// price as 30,000 input tokens and 300 output tokens, $0.0945 a call; the conversation's text
	// carries the input tokens the images do not. The task has spent $4.50 already, so a ceiling
	// that counts the base64 as text, $3.13, is refused at once.
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":30000,"output_tokens":300}}`)
	}), nil)
	earlier, _ := g.budget.Reserve(context.Background(), "c1", llm.Ask{Fixed: 1})
	earlier.Settle(4_500_000)
	shot := `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + screenshot(t) + `"}}`
	history := strings.Repeat("an earlier turn of the conversation, as text. ", 1_520)
	body := `{"model":"claude-sonnet-5-5","max_tokens":4096,"messages":[{"role":"user","content":"` + history +
		`"},{"role":"user","content":[` + strings.Repeat(shot+",", 4) + shot + `]}]}`
	calls := 0
	for {
		resp, out := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), body)
		if resp.StatusCode != 200 {
			if resp.StatusCode != http.StatusPaymentRequired {
				t.Fatalf("call %d: %d %s", calls+1, resp.StatusCode, out)
			}
			break
		}
		calls++
	}
	// Refused only when what is left cannot pay for the request's input, about $0.09.
	if info, _ := g.budget.Task("c1"); info.SpentUSD < info.LimitUSD-0.1 || info.SpentUSD > info.LimitUSD {
		t.Fatalf("refused after %d calls, with $%.4f of $%.2f spent", calls, info.SpentUSD, info.LimitUSD)
	}
}

func TestABudgetRefusalIsAnnounced(t *testing.T) {
	var hits atomic.Int32
	g := newGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
	g.budget.Begin("c1", "task-1", 0.00005) // less than the request's input costs
	sub, cancel := g.events.Subscribe(8)
	defer cancel()
	resp, body := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != http.StatusPaymentRequired || !strings.Contains(body, `"needUSD"`) || hits.Load() != 0 {
		t.Fatalf("%d %s, provider reached %d times", resp.StatusCode, body, hits.Load())
	}
	for {
		select {
		case e := <-sub:
			if b, ok := e.Data.(events.Budget); ok && e.Type == events.TypeBudget && b.Scope == "task" && b.TaskID == "task-1" && b.LimitUSD == 0.00005 {
				return
			}
		case <-time.After(time.Second):
			t.Fatal("the refusal published no budget.exceeded")
		}
	}
}

func TestCountingTokensNeverWaits(t *testing.T) {
	release, started := make(chan struct{}), make(chan struct{})
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/count_tokens") {
			io.WriteString(rw, `{"input_tokens":10}`)
			return
		}
		rw.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(rw, "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}\n\n")
		rw.(http.Flusher).Flush()
		close(started)
		<-release
	}), nil)
	streamed := make(chan int, 1)
	go func() { streamed <- g.send(g.cell, g.tok, fourFifty) }() // holds $4.50 of the $5 task
	<-started
	counted := make(chan int, 1)
	go func() {
		status, _ := g.call(g.cell, "http://llm.ldot/anthropic/messages/count_tokens", g.key(), `{"model":"claude-sonnet-5-5","messages":[]}`)
		counted <- status
	}()
	select {
	case status := <-counted:
		if status != 200 {
			t.Fatalf("count_tokens: %d", status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("count_tokens waited for a running stream")
	}
	close(release)
	<-streamed
	if l := g.waitLine(func(l audit.Line) bool { return strings.HasSuffix(l.Path, "/count_tokens") }); l.CostMicroUSD != 0 {
		t.Fatalf("counting was charged: %+v", l)
	}
}

func TestASecretReplacedWhileARequestWaitsIsNotSent(t *testing.T) {
	release, started := make(chan struct{}), make(chan struct{}, 2)
	var mu sync.Mutex
	var sent []string
	g := newGateway(t, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		mu.Lock()
		sent = append(sent, r.Header.Get("X-Api-Key"))
		mu.Unlock()
		started <- struct{}{}
		<-release
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":20,"output_tokens":10}}`)
	}), nil)
	first := make(chan int, 1)
	go func() { first <- g.send(g.cell, g.tok, fourFifty) }() // holds $4.50 of the $5 task
	<-started
	waiting := make(chan int, 1)
	go func() {
		waiting <- g.send(g.cell, g.tok, `{"model":"claude-sonnet-5-5","max_tokens":100000,"messages":[]}`) // $1.50: waits
	}()
	time.Sleep(200 * time.Millisecond)
	// The user replaces the key, as PUT /v1/secrets/anthropic does: store it, then revoke its surrogates.
	g.vault.Put(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, []byte("replacement-secret-value-for-test"))
	g.registry.RevokeSecret("anthropic")
	close(release)
	<-first
	status := <-waiting
	mu.Lock()
	defer mu.Unlock()
	if status != http.StatusForbidden || len(sent) != 1 {
		t.Fatalf("the waiting request got %d; the provider saw keys %q", status, sent)
	}
}
