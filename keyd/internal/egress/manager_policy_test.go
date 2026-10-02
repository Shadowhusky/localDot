package egress

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type blockedStore struct {
	*vault.Memory
	mu               sync.Mutex
	entered, release chan struct{}
}

func TestModelChangesCancelRequestsWaitingForBudget(t *testing.T) {
	m, w := newManager(t)
	var hits atomic.Int32
	w.tlsUpstream("api.anthropic.com", http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		io.WriteString(rw, `{"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	if err := m.SetModels("anthropic", []llm.Price{{Model: "claude-sonnet-5-5", Input: 3, Output: 15, MaxOutput: 100}}); err != nil {
		t.Fatal(err)
	}
	o, err := m.Open(OpenRequest{CellID: "c1", Role: "brain", Secrets: []string{"anthropic"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.BeginTask("c1", "session", 5); err != nil {
		t.Fatal(err)
	}
	hold, err := m.d.Budget.Reserve(context.Background(), "c1", llm.Ask{Fixed: 5_000_000})
	if err != nil {
		t.Fatal(err)
	}
	defer hold.Release()
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", strings.NewReader(sonnet))
	req.Header.Set("X-Api-Key", o.Surrogates["anthropic"])
	answered := make(chan int, 1)
	go func() {
		resp, err := cellClient(w, o).Do(req)
		if err != nil {
			answered <- 0
			return
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		answered <- resp.StatusCode
	}()
	select {
	case code := <-answered:
		t.Fatalf("request bypassed the held budget: %d", code)
	case <-time.After(150 * time.Millisecond):
	}
	if err := m.SetModels("anthropic", nil); err != nil {
		t.Fatal(err)
	}
	// The canceled waiter must finish even while the unrelated reservation still
	// occupies the budget. It cannot wait for room and use its old price later.
	select {
	case code := <-answered:
		if code != 503 && code != 403 {
			t.Fatalf("policy change answered %d", code)
		}
	case <-time.After(time.Second):
		t.Fatal("policy change left the old request waiting for budget")
	}
	if hits.Load() != 0 {
		t.Fatal("a request admitted by old model policy reached the provider")
	}
}

func (s *blockedStore) Put(id string, value []byte) error {
	s.mu.Lock()
	entered, release := s.entered, s.release
	s.mu.Unlock()
	if entered != nil {
		close(entered)
		<-release
	}
	return s.Memory.Put(id, value)
}

func TestSecretReplacementRevokesBeforeStorageAndSerializesMint(t *testing.T) {
	m, _ := newManager(t)
	store := &blockedStore{Memory: vault.NewMemory()}
	m.d.Vault, _ = vault.Open(store, "")
	rec := vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}
	if _, err := m.PutSecret(rec, []byte(realValue)); err != nil {
		t.Fatal(err)
	}
	o, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	if err != nil {
		t.Fatal(err)
	}
	old := m.cells["c1"].cell.current()
	entered, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	defer unblock.Do(func() { close(release) })
	store.mu.Lock()
	store.entered, store.release = entered, release
	store.mu.Unlock()
	rec.Hosts = []string{"maps.example.test"}
	rotated := make(chan error, 1)
	go func() { _, err := m.PutSecret(rec, []byte("rotated-secret-value")); rotated <- err }()
	<-entered
	if old.ctx.Err() == nil {
		t.Error("old requests were live while the replacement value was being stored")
	}
	if _, ok := m.d.Registry.Lookup(o.Surrogates["weather"]); ok {
		t.Error("old binding remained usable during rotation")
	}
	minted := make(chan error, 1)
	go func() { _, err := m.Mint("c1", []string{"weather"}); minted <- err }()
	select {
	case err := <-minted:
		t.Fatalf("Mint escaped the rotation lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	unblock.Do(func() { close(release) })
	if err := <-rotated; err != nil {
		t.Fatal(err)
	}
	var malformed *RequestError
	if err := <-minted; !errors.As(err, &malformed) {
		t.Fatalf("Mint did not enforce the new binding against the original CA: %v", err)
	}
	if len(m.d.Registry.ForCell("c1")) != 0 {
		t.Fatal("rotation left a surrogate under the old CA")
	}
}

func TestInvalidPolicyDoesNotInterruptACell(t *testing.T) {
	m, _ := newManager(t)
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "brain"}); err != nil {
		t.Fatal(err)
	}
	old := m.cells["c1"].cell.current()
	if err := m.SetModels("anthropic", []llm.Price{{Model: "bad model"}}); err == nil {
		t.Fatal("invalid model accepted")
	}
	if err := m.SetLimits(llm.Limits{PerTaskUSD: 20, PerDayUSD: 1}); err == nil {
		t.Fatal("invalid limits accepted")
	}
	if old.ctx.Err() != nil || old != m.cells["c1"].cell.current() {
		t.Fatal("a rejected edit interrupted an existing cell")
	}
}

func TestFailedPolicySaveKeepsTheOldPolicyAndFreshAdmission(t *testing.T) {
	m, _ := newManager(t)
	settingsPath := filepath.Join(t.TempDir(), "settings.json")
	s, err := llm.OpenSettings(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetModels("anthropic", []llm.Price{{Model: "existing", Input: 3}}); err != nil {
		t.Fatal(err)
	}
	m.d.Settings = s
	if _, err := m.Open(OpenRequest{CellID: "c1", Role: "brain"}); err != nil {
		t.Fatal(err)
	}
	old := m.cells["c1"].cell.current()
	// Removing the private parent forces an atomic-save failure after validation.
	if err := os.RemoveAll(filepath.Dir(settingsPath)); err != nil {
		t.Fatal(err)
	}
	if err := m.SetModels("anthropic", []llm.Price{{Model: "replacement", Input: 30}}); err == nil {
		t.Fatal("failed persistence reported success")
	}
	if _, ok := s.Price("anthropic", "existing"); !ok {
		t.Fatal("failed save removed the prior model")
	}
	if _, ok := s.Price("anthropic", "replacement"); ok {
		t.Fatal("failed save published a new model")
	}
	fresh := m.cells["c1"].cell.current()
	if old.ctx.Err() == nil || fresh == old || fresh.ctx.Err() != nil {
		t.Fatal("failed policy update left an old or unusable generation")
	}
}
