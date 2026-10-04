package egress

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func taskPrices(rate float64) llm.TaskPricing {
	return llm.TaskPricing{V: 1, Routes: []llm.TaskPricingRoute{{Route: "anthropic", Models: []llm.Price{{Model: "claude-sonnet-5-5", Input: rate, Output: 2, MaxOutput: 100}}}}}
}
func pricedCell(t *testing.T, m *Manager, id, task string, rate float64) Opened {
	t.Helper()
	o, err := m.Open(OpenRequest{CellID: id, Role: "brain", Secrets: []string{"anthropic"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.BeginPricedTask(id, task, 5, taskPrices(rate)); err != nil {
		t.Fatal(err)
	}
	// Legacy pricing fixtures use historical non-ULID task names. This opens only
	// their owned private transport gate; public-control acceptance uses real ULIDs.
	gate := m.cells[id].cell.current().model
	snapshot := gate.Snapshot()
	if _, err := gate.Resume(snapshot.GenerationID, snapshot.Epoch); err != nil {
		t.Fatal(err)
	}
	return o
}
func TestTaskPricingIsolatedFromOtherTasksAndGlobalTables(t *testing.T) {
	m, w := newManager(t)
	var hits atomic.Int32
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	w.tlsUpstream("api.anthropic.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":1000,"output_tokens":100}}`)
	}))
	a := pricedCell(t, m, "a", "task-a", 1)
	ga := m.cells["a"].cell.current()
	send := func(o Opened) error {
		req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(sonnet))
		req.Header.Set("X-Api-Key", o.Surrogates["anthropic"])
		resp, err := cellClient(w, o).Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		_, err = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode != 200 {
			return errors.New("gateway refused snapshot request")
		}
		return err
	}
	done := make(chan error, 1)
	go func() { done <- send(a) }()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("positive upstream never entered")
	}
	b := pricedCell(t, m, "b", "task-b", 9)
	if err := m.SetModels("anthropic", nil); err != nil {
		t.Fatal(err)
	}
	if ga.ctx.Err() != nil || m.cells["a"].cell.current() != ga {
		t.Fatal("snapshot task interrupted by global table or other task")
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := send(b); err != nil {
		t.Fatal(err)
	}
	ai, _ := m.d.Budget.Task("a")
	bi, _ := m.d.Budget.Task("b")
	if ai.SpentUSD != .0012 || bi.SpentUSD != .0092 {
		t.Fatalf("tasks used mutable/wrong prices: a=%+v b=%+v", ai, bi)
	}
	// A global allowlist cannot expand the immutable task's allowed models.
	if err := m.SetModels("anthropic", []llm.Price{{Model: "outside", Input: 1, Output: 1, MaxOutput: 100}}); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(strings.Replace(sonnet, "claude-sonnet-5-5", "outside", 1)))
	req.Header.Set("X-Api-Key", a.Surrogates["anthropic"])
	resp, err := cellClient(w, a).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 || hits.Load() != 2 {
		t.Fatalf("global allowlist bypassed snapshot: %d hits=%d", resp.StatusCode, hits.Load())
	}
}
func TestTaskPricingGlobalMutationRetiresOnlyLegacyAttachments(t *testing.T) {
	m, _ := newManager(t)
	pricedCell(t, m, "priced", "priced-task", 1)
	if _, err := m.Open(OpenRequest{CellID: "legacy", Role: "brain", Secrets: []string{"anthropic"}}); err != nil {
		t.Fatal(err)
	}
	if err := m.BeginTask("legacy", "legacy-task", 5); err != nil {
		t.Fatal(err)
	}
	priced, legacy := m.cells["priced"].cell.current(), m.cells["legacy"].cell.current()
	if err := m.SetModels("anthropic", []llm.Price{{Model: "m", Input: 1, Output: 1, MaxOutput: 10}}); err != nil {
		t.Fatal(err)
	}
	if priced.ctx.Err() != nil || legacy.ctx.Err() == nil {
		t.Fatal("global model publication has wrong scope")
	}
	// Shared day limits remain global policy for both kinds of account.
	if err := m.SetLimits(llm.Limits{PerTaskUSD: 5, PerDayUSD: 30}); err != nil {
		t.Fatal(err)
	}
	if priced.ctx.Err() == nil {
		t.Fatal("snapshot bypassed global budget control")
	}
}
func TestTaskPricingBindingChangesRefuseRecovery(t *testing.T) {
	m, _ := newManager(t)
	pricedCell(t, m, "old", "session", 1)
	if err := m.EndTask("old"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.PutSecret(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "openai"}, []byte("new-valid-secret-for-fixture")); err != nil {
		t.Fatal(err)
	}
	opened, err := m.Open(OpenRequest{CellID: "new", Role: "brain", Secrets: []string{"anthropic"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.BeginPricedTask("new", "session", 5, taskPrices(1)); !errors.Is(err, llm.ErrTaskPricingConflict) {
		t.Fatalf("retargeted binding adopted: %v", err)
	}
	if _, ok := m.d.Budget.Task("new"); ok {
		t.Fatal("binding conflict attached cell")
	}
	// Backward-compatible omission may reattach the durable account, but cannot
	// sidestep its frozen destination/auth binding with a freshly minted credential.
	if err := m.BeginTask("new", "session", 0); err != nil {
		t.Fatal(err)
	}
	openFixtureAdmission(t, m, "new")
	req := httptest.NewRequest("POST", "http://llm.ldot/anthropic/chat/completions", strings.NewReader(sonnet))
	req.Header.Set("Authorization", "Bearer "+opened.Surrogates["anthropic"])
	response := httptest.NewRecorder()
	m.cells["new"].cell.serveGateway(response, req)
	if response.Code != 403 || response.Header().Get("X-Keyd-Reason") != ReasonModelNotAllowed {
		t.Fatalf("legacy omission bypassed immutable binding: %d %s", response.Code, response.Body.String())
	}
}
func TestTaskPricingValueRotationKeepsPolicyWithFreshCredentials(t *testing.T) {
	m, _ := newManager(t)
	pricedCell(t, m, "old", "session", 1)
	if _, err := m.Revoke("old"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.PutSecret(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, []byte("rotated-valid-secret-for-fixture")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Open(OpenRequest{CellID: "new", Role: "brain", Secrets: []string{"anthropic"}}); err != nil {
		t.Fatal(err)
	}
	if err := m.BeginPricedTask("new", "session", 5, taskPrices(1)); err != nil {
		t.Fatal(err)
	}
}
func TestTaskPricingEndInvalidatesGenerationAndLease(t *testing.T) {
	m, _ := newManager(t)
	pricedCell(t, m, "a", "session", 1)
	lease, err := m.d.Budget.Capture("a")
	if err != nil {
		t.Fatal(err)
	}
	old := m.cells["a"].cell.current()
	if err := m.EndTask("a"); err != nil {
		t.Fatal(err)
	}
	if old.ctx.Err() == nil || m.d.Budget.Current(lease) {
		t.Fatal("EndTask retained admission")
	}
	if err := m.BeginPricedTask("a", "next", 5, taskPrices(3)); err != nil {
		t.Fatal(err)
	}
	if h, err := m.d.Budget.ReserveFor(context.Background(), lease, llm.Ask{}); !errors.Is(err, llm.ErrTaskChanged) {
		if h != nil {
			h.Release()
		}
		t.Fatalf("old lease reserved on replacement: %v", err)
	}
}
func TestTaskPricingRejectsUnauthorizedRouteAndUnpricedRemote(t *testing.T) {
	m, _ := newManager(t)
	if _, err := m.Open(OpenRequest{CellID: "a", Role: "brain"}); err != nil {
		t.Fatal(err)
	}
	if err := m.BeginPricedTask("a", "session", 5, taskPrices(1)); err == nil {
		t.Fatal("snapshot without cell credential accepted")
	}
	if _, err := m.Mint("a", []string{"anthropic"}); err != nil {
		t.Fatal(err)
	}
	p := taskPrices(0)
	p.Routes[0].Models[0].Output = 0
	if err := m.BeginPricedTask("a", "session", 5, p); err == nil {
		t.Fatal("unpriced remote allowed")
	}
}

// The task's model cap remains policy even when its output side is explicitly free.
// Observing the rewritten upstream body catches both mutable-table fallback and skipped caps.
func TestTaskPricingKeepsOutputCapsForFreeOutputAndLocalModels(t *testing.T) {
	for _, local := range []bool{false, true} {
		t.Run(map[bool]string{false: "remote-input-only", true: "local-free"}[local], func(t *testing.T) {
			m, w := newManager(t)
			seen := make(chan map[string]any, 2)
			handler := http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				seen <- body
				rw.Header().Set("Content-Type", "application/json")
				io.WriteString(rw, `{"usage":{"input_tokens":1,"output_tokens":1}}`)
			})
			route, op := "anthropic", "messages"
			secrets := []string{route}
			if local {
				upstream := httptest.NewServer(handler)
				defer upstream.Close()
				route, op, secrets = "lmstudio", "chat/completions", nil
				binding := keys.LocalRoutes()[route]
				binding.Upstream, _ = url.Parse(upstream.URL + "/v1")
				m.d.Local = map[string]keys.Binding{route: binding}
				m.d.LocalDialer = PinnedFor(m.d.Local)
			} else {
				w.tlsUpstream("api.anthropic.com", handler)
			}
			o, err := m.Open(OpenRequest{CellID: "a", Role: "brain", Secrets: secrets})
			if err != nil {
				t.Fatal(err)
			}
			price := llm.Price{Model: "m", Input: 1, MaxOutput: 7}
			if local {
				price.Input = 0
			}
			pricing := llm.TaskPricing{V: 1, Routes: []llm.TaskPricingRoute{{Route: route, Models: []llm.Price{price}}}}
			if err := m.BeginPricedTask("a", "session", 5, pricing); err != nil {
				t.Fatal(err)
			}
			openFixtureAdmission(t, m, "a")
			price.MaxOutput = 1000
			if err := m.SetModels(route, []llm.Price{price}); err != nil {
				t.Fatal(err)
			}
			for _, cap := range []string{``, `,"max_tokens":99`} {
				req, _ := http.NewRequest("POST", "http://llm.ldot/"+route+"/"+op, strings.NewReader(`{"model":"m","messages":[]`+cap+`}`))
				if !local {
					req.Header.Set("X-Api-Key", o.Surrogates[route])
				}
				resp, err := cellClient(w, o).Do(req)
				if err != nil {
					t.Fatal(err)
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if resp.StatusCode != 200 {
					t.Fatalf("positive request: %d", resp.StatusCode)
				}
				if got := <-seen; got["max_tokens"] != float64(7) {
					t.Fatalf("snapshot cap escaped: %v", got)
				}
			}
		})
	}
}

type pricingBodyGate struct {
	io.Reader
	entered chan struct{}
	release chan struct{}
	started bool
}

func (b *pricingBodyGate) Read(p []byte) (int, error) {
	if !b.started {
		b.started = true
		close(b.entered)
		<-b.release
	}
	return b.Reader.Read(p)
}
func (b *pricingBodyGate) Close() error { return nil }

func TestTaskPricingPinsAttachmentBeforeReadingBody(t *testing.T) {
	m, w := newManager(t)
	var hits atomic.Int32
	w.tlsUpstream("api.anthropic.com", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	o := pricedCell(t, m, "a", "old-session", 1)
	body := &pricingBodyGate{Reader: strings.NewReader(sonnet), entered: make(chan struct{}), release: make(chan struct{})}
	defer func() {
		select {
		case <-body.release:
		default:
			close(body.release)
		}
	}()
	req := httptest.NewRequest("POST", "http://llm.ldot/anthropic/messages", body)
	req.Header.Set("X-Api-Key", o.Surrogates["anthropic"])
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { m.cells["a"].cell.serveGateway(response, req); close(done) }()
	select {
	case <-body.entered:
	case <-time.After(time.Second):
		t.Fatal("request never started its body")
	}
	// Retire the account attachment without generation cancellation, so this specifically
	// verifies the lease guard instead of passing because the existing Stop guard fired.
	m.d.Budget.End("a")
	if err := m.BeginPricedTask("a", "replacement", 5, taskPrices(9)); err != nil {
		t.Fatal(err)
	}
	close(body.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("old body remained blocked")
	}
	info, _ := m.d.Budget.Task("a")
	if response.Code != 503 || hits.Load() != 0 || info.SpentUSD != 0 {
		t.Fatalf("old body used replacement attachment: status=%d hits=%d account=%+v", response.Code, hits.Load(), info)
	}
	req = httptest.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(sonnet))
	req.Header.Set("X-Api-Key", o.Surrogates["anthropic"])
	response = httptest.NewRecorder()
	m.cells["a"].cell.serveGateway(response, req)
	if response.Code != 200 || hits.Load() != 1 {
		t.Fatalf("replacement positive control: status=%d hits=%d", response.Code, hits.Load())
	}
}
