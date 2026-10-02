package egress

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
)

func TestBeginTaskPropagatesPersistenceFailure(t *testing.T) {
	m, _ := newManager(t)
	b, err := llm.OpenBudget(filepath.Join(t.TempDir(), "missing", "spend.json"), m.d.Settings.Limits, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	m.d.Budget = b
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "brain", Secrets: []string{"anthropic"}}); err != nil {
		t.Fatal(err)
	}
	if err := m.BeginTask("c1", "task-1", 5); err == nil {
		t.Fatal("the manager reported a task started after its budget save failed")
	}
	if info, _ := m.Cell("c1"); info.Task != nil {
		t.Fatalf("a refused task start appeared in the cell listing: %+v", info.Task)
	}
}

func TestManagerRejectsInvalidTaskLimits(t *testing.T) {
	m, _ := newManager(t)
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "brain"}); err != nil {
		t.Fatal(err)
	}
	for _, value := range []float64{-1, math.NaN(), math.Inf(1), 10_001, 0.0000001} {
		var invalid *RequestError
		if err := m.BeginTask("c1", "task", value); !errors.As(err, &invalid) {
			t.Fatalf("invalid task limit %v was not a malformed request: %v", value, err)
		}
		if info, _ := m.Cell("c1"); info.Task != nil {
			t.Fatalf("invalid limit attached a task: %+v", info)
		}
	}
}

func TestCloseCannotRemoveAReplacementCellsCA(t *testing.T) {
	m, w := newManager(t)
	old, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	oldCell := m.cells["c1"].cell
	m.mu.Unlock()
	// Stop the old cell's Close after it has revoked credentials but before its
	// listener/CA cleanup, then try to reopen the same ID concurrently.
	oldCell.mu.Lock()
	locked := true
	defer func() {
		if locked {
			oldCell.mu.Unlock()
		}
	}()
	closed := make(chan error, 1)
	go func() { closed <- m.Close("c1") }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, ok := w.registry.Lookup(old.Surrogates["weather"]); !ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Close never revoked the old credentials")
		}
		time.Sleep(time.Millisecond)
	}
	type openResult struct {
		opened Opened
		err    error
	}
	reopened := make(chan openResult, 1)
	go func() {
		o, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
		reopened <- openResult{o, err}
	}()
	var result openResult
	early := false
	select {
	case result = <-reopened:
		early = true
	case <-time.After(200 * time.Millisecond):
	}
	oldCell.mu.Unlock()
	locked = false
	if err := <-closed; err != nil {
		t.Fatal(err)
	}
	if !early {
		select {
		case result = <-reopened:
		case <-time.After(2 * time.Second):
			t.Fatal("the replacement never opened after Close completed")
		}
	}
	if result.err != nil {
		t.Fatal(result.err)
	}
	if _, err := os.Stat(result.opened.CAPath); err != nil {
		t.Fatalf("old cleanup removed the replacement's CA: %v", err)
	}
	if _, ok := w.registry.Lookup(result.opened.Surrogates["weather"]); !ok {
		t.Fatal("old cleanup revoked the replacement's surrogate")
	}
}

func TestManagerShutdownCannotLeaveNewCellsOpen(t *testing.T) {
	m, _ := newManager(t)
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "brain"}); err != nil {
		t.Fatal(err)
	}
	m.CloseAll()
	if _, err := m.Open(OpenRequest{CellID: "c2", Role: "brain"}); err == nil {
		t.Fatal("a shut-down manager admitted another cell")
	}
	if len(m.Cells()) != 0 {
		t.Fatal("shutdown left a live cell")
	}
}

func TestRevokeAndReplacementKeepTheSessionsSpend(t *testing.T) {
	for _, action := range []string{"revoke", "replace"} {
		t.Run(action, func(t *testing.T) {
			m, _ := newManager(t)
			if _, err := m.Open(OpenRequest{CellID: "c1", Role: "brain"}); err != nil {
				t.Fatal(err)
			}
			if err := m.BeginTask("c1", "session", 8); err != nil {
				t.Fatal(err)
			}
			h, err := m.d.Budget.Reserve(context.Background(), "c1", llm.Ask{Fixed: 3_000_000})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := h.Settle(3_000_000); err != nil {
				t.Fatal(err)
			}
			cell := "c1"
			if action == "revoke" {
				if _, err := m.Revoke(cell); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := m.Close(cell); err != nil {
					t.Fatal(err)
				}
				cell = "c2"
				if _, err := m.Open(OpenRequest{CellID: cell, Role: "brain"}); err != nil {
					t.Fatal(err)
				}
			}
			if err := m.BeginTask(cell, "session", 0); err != nil {
				t.Fatal(err)
			}
			info, _ := m.Cell(cell)
			if info.Task == nil || info.Task.SpentUSD != 3 || info.Task.LimitUSD != 8 {
				t.Fatalf("%s reset the session account: %+v", action, info.Task)
			}
		})
	}
}

func TestRevokeStopsKeylessLocalGatewayRequests(t *testing.T) {
	m, w := newManager(t)
	var hits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		io.WriteString(rw, `{"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
	}))
	defer upstream.Close()
	binding := keys.LocalRoutes()["lmstudio"]
	binding.Upstream, _ = url.Parse(upstream.URL + "/v1")
	m.d.Local = map[string]keys.Binding{"lmstudio": binding}
	m.d.LocalDialer = PinnedFor(m.d.Local)
	if err := m.d.Settings.SetModels("lmstudio", []llm.Price{{Model: "local"}}); err != nil {
		t.Fatal(err)
	}
	o, err := m.Open(OpenRequest{CellID: "c1", Role: "brain"})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.BeginTask("c1", "session", 5); err != nil {
		t.Fatal(err)
	}
	client := cellClient(w, o)
	post := func() *http.Response {
		resp, err := client.Post("http://llm.ldot/lmstudio/chat/completions", "application/json", strings.NewReader(`{"model":"local"}`))
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp
	}
	if resp := post(); resp.StatusCode != http.StatusOK {
		t.Fatalf("local route before Stop: %d", resp.StatusCode)
	}
	if _, err := m.Revoke("c1"); err != nil {
		t.Fatal(err)
	}
	if resp := post(); resp.StatusCode != http.StatusForbidden || resp.Header.Get("X-Keyd-Reason") != ReasonNoTask || hits.Load() != 1 {
		t.Fatalf("local route after Stop: %d %q, provider hits %d", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
}
