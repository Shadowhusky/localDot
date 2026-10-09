package admin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const fakeKey = "real-secret-value-for-test"

type fixture struct {
	srv      *httptest.Server
	s        *Server
	registry *keys.Registry
	auditLog string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	return newFixtureWithDeps(t, nil)
}

func newFixtureWithDeps(t *testing.T, configure func(*egress.Deps)) *fixture {
	t.Helper()
	dir := t.TempDir()
	v, _ := vault.Open(vault.NewMemory(), filepath.Join(dir, "secrets.json"))
	log, _ := audit.Open(filepath.Join(dir, "audit.jsonl"))
	t.Cleanup(func() { log.Close() })
	settings, _ := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	budget, _ := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	opener, _ := vault.NewOpener()
	hub := events.NewHub()
	registry := keys.NewRegistry()
	guard := netguard.New(netguard.InterfacePrefixes)
	deps := egress.Deps{
		Registry: registry, Vault: v, Audit: log, Events: hub,
		Dialer: &netguard.Dialer{Guard: guard, Resolver: &noResolver{}}, Budget: budget, Settings: settings,
	}
	if configure != nil {
		configure(&deps)
	}
	m := egress.NewManager(egress.ManagerDeps{
		Deps:     deps,
		CellsDir: filepath.Join(dir, "cells"),
	})
	t.Cleanup(m.CloseAll)
	s := &Server{Manager: m, Vault: deps.Vault, Registry: registry, Opener: opener, Settings: settings, Budget: budget, Audit: log, Events: hub, BootID: "boot-1", Version: "test"}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &fixture{srv: srv, s: s, registry: registry, auditLog: filepath.Join(dir, "audit.jsonl")}
}

type noResolver struct{}

func (noResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return nil, errors.New("no DNS in these tests")
}

func (f *fixture) call(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var r io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		r = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, f.srv.URL+path, r)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// record is the vault record a PUT of fields would make, which the value is sealed for.
func record(id string, fields map[string]any) vault.Record {
	raw, _ := json.Marshal(fields)
	var rec vault.Record
	json.Unmarshal(raw, &rec)
	rec.ID = id
	return rec
}

func (f *fixture) sealedPut(t *testing.T, id string, fields map[string]any, value string) (int, map[string]any) {
	t.Helper()
	sealed, err := vault.Seal(f.s.Opener.PublicKey(), record(id, fields), []byte(value))
	if err != nil {
		t.Fatal(err)
	}
	fields["sealed"] = sealed
	return f.call(t, "PUT", "/v1/secrets/"+id, fields)
}

func weather() map[string]any {
	return map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer"}
}

func TestStatus(t *testing.T) {
	f := newFixture(t)
	code, body := f.call(t, "GET", "/v1/status", nil)
	if code != 200 || body["bootId"] != "boot-1" || body["sealKey"] != f.s.Opener.PublicKey() || body["version"] != "test" {
		t.Fatalf("%d %v", code, body)
	}
	if state, _ := body["audit"].(map[string]any); state["ok"] != true {
		t.Fatalf("audit %v", body["audit"])
	}
	f.s.Audit.Close()
	f.s.Audit.Write(audit.Line{Kind: audit.KindKeyd, Decision: audit.Allow})
	if _, body := f.call(t, "GET", "/v1/status", nil); body["audit"].(map[string]any)["ok"] != false {
		t.Fatalf("audit after a failed write %v", body["audit"])
	}
}

func TestSecretsArriveSealedAndNeverLeave(t *testing.T) {
	f := newFixture(t)
	code, body := f.sealedPut(t, "weather", weather(), fakeKey)
	if code != 200 || body["id"] != "weather" || body["hosts"] == nil {
		t.Fatalf("put: %d %v", code, body)
	}
	if got, _ := f.s.Vault.Value("weather"); string(got) != fakeKey {
		t.Fatalf("vault holds %q", got)
	}
	resp, _ := http.Get(f.srv.URL + "/v1/secrets")
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(raw), `"weather"`) || strings.Contains(string(raw), fakeKey) {
		t.Fatalf("listing: %s", raw)
	}
	logged, _ := os.ReadFile(f.auditLog)
	if !strings.Contains(string(logged), `"reason":"secret-put"`) || strings.Contains(string(logged), fakeKey) {
		t.Fatalf("audit: %s", logged)
	}
}

// A key whose stored value is gone is listed, and counted in the status, as one to enter again,
// until it is stored again.
func TestAKeyToEnterAgainIsListedUntilItIsStored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secrets.json")
	store := vault.NewMemory()
	warm, _ := vault.Open(store, path)
	if err := warm.Put(record("weather", weather()), []byte(fakeKey)); err != nil {
		t.Fatal(err)
	}
	store.Delete("weather")
	cold, _ := vault.Open(store, path)
	f := newFixtureWithDeps(t, func(d *egress.Deps) { d.Vault = cold })
	if _, err := cold.Value("weather"); !errors.Is(err, vault.ErrNotFound) {
		t.Fatalf("Value = %v", err)
	}
	listed := func() (bool, float64) {
		_, list := f.call(t, "GET", "/v1/secrets", nil)
		_, status := f.call(t, "GET", "/v1/status", nil)
		secrets, _ := list["secrets"].([]any)
		first, _ := secrets[0].(map[string]any)
		return first["reenter"] == true, status["reenter"].(float64)
	}
	if reenter, count := listed(); !reenter || count != 1 {
		t.Fatalf("before: reenter %v, count %v", reenter, count)
	}
	if code, _ := f.sealedPut(t, "weather", weather(), fakeKey); code != 200 {
		t.Fatalf("put %d", code)
	}
	if reenter, count := listed(); reenter || count != 0 {
		t.Fatalf("after: reenter %v, count %v", reenter, count)
	}
}

func TestSecretPutRefusals(t *testing.T) {
	f := newFixture(t)
	wrongID, _ := vault.Seal(f.s.Opener.PublicKey(), record("other", weather()), []byte(fakeKey))
	evil := weather()
	evil["hosts"] = []string{"evil.example.test"}
	otherHosts, _ := vault.Seal(f.s.Opener.PublicKey(), record("weather", evil), []byte(fakeKey))
	cases := map[string]struct {
		id     string
		fields map[string]any
	}{
		"sealed for another id":   {"weather", map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer", "sealed": wrongID}},
		"sealed for another host": {"weather", map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer", "sealed": otherHosts}},
		"bad binding":             {"weather", map[string]any{"kind": "http", "hosts": []string{"localhost"}, "header": "Authorization", "format": "bearer"}},
		"unknown field":           {"weather", map[string]any{"kind": "http", "hosts": []string{"api.example.test"}, "header": "Authorization", "format": "bearer", "requir": true}},
		"bad id":                  {"Weather", weather()},
		"short value":             {"weather", weather()},
	}
	for name, c := range cases {
		value := fakeKey
		if name == "short value" {
			value = "short"
		}
		var code int
		if _, sealed := c.fields["sealed"]; sealed {
			code, _ = f.call(t, "PUT", "/v1/secrets/"+c.id, c.fields)
		} else {
			code, _ = f.sealedPut(t, c.id, c.fields, value)
		}
		if code != 400 {
			t.Errorf("%s: %d, want 400", name, code)
		}
	}
	if len(f.s.Vault.Records()) != 0 {
		t.Fatal("a refused put stored a secret")
	}
}

func TestReplacingOrDeletingASecretRevokesItsSurrogates(t *testing.T) {
	f := newFixture(t)
	f.sealedPut(t, "weather", weather(), fakeKey)
	code, opened := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "desktop", "secrets": []string{"weather"}})
	if code != 201 {
		t.Fatalf("open: %d %v", code, opened)
	}
	tok := opened["surrogates"].(map[string]any)["weather"].(string)
	f.sealedPut(t, "weather", weather(), "rotated-secret-value-for-test")
	if _, ok := f.registry.Lookup(tok); ok {
		t.Fatal("a surrogate survived its secret being replaced")
	}
	code, minted := f.call(t, "POST", "/v1/cells/c1/surrogates", map[string]any{"secrets": []string{"weather"}})
	if code != 200 {
		t.Fatalf("mint: %d %v", code, minted)
	}
	if code, _ := f.call(t, "DELETE", "/v1/secrets/weather", nil); code != 204 {
		t.Fatalf("delete: %d", code)
	}
	if len(f.registry.ForCell("c1")) != 0 {
		t.Fatal("surrogates survived their secret being deleted")
	}
	if code, _ := f.call(t, "DELETE", "/v1/secrets/weather", nil); code != 404 {
		t.Fatalf("second delete: %d", code)
	}
}

func TestCellLifecycle(t *testing.T) {
	f := newFixture(t)
	f.sealedPut(t, "weather", weather(), fakeKey)
	code, opened := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "desktop", "secrets": []string{"weather"}})
	if code != 201 || opened["proxyToken"] == "" || !strings.Contains(opened["caCertPem"].(string), "BEGIN CERTIFICATE") {
		t.Fatalf("open: %d %v", code, opened)
	}
	if code, _ := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c1", "role": "desktop"}); code != 409 {
		t.Fatalf("reopen: %d", code)
	}
	if code, _ := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "c2", "role": "root"}); code != 400 {
		t.Fatalf("bad role: %d", code)
	}
	if code, _ := f.call(t, "PUT", "/v1/cells/c1/task", map[string]any{"taskId": "t1", "budgetUSD": 2}); code != 204 {
		t.Fatalf("task: %d", code)
	}
	code, info := f.call(t, "GET", "/v1/cells/c1", nil)
	if code != 200 || info["task"].(map[string]any)["limitUSD"] != 2.0 || info["role"] != "desktop" {
		t.Fatalf("get: %d %v", code, info)
	}
	if code, body := f.call(t, "POST", "/v1/cells/c1/revoke", nil); code != 200 || body["revoked"] != 1.0 {
		t.Fatalf("revoke: %d %v", code, body)
	}
	if code, _ := f.call(t, "DELETE", "/v1/cells/c1/task", nil); code != 204 {
		t.Fatalf("end task: %d", code)
	}
	if code, _ := f.call(t, "DELETE", "/v1/cells/c1", nil); code != 204 {
		t.Fatalf("close: %d", code)
	}
	for _, path := range []string{"/v1/cells/c1"} {
		if code, _ := f.call(t, "GET", path, nil); code != 404 {
			t.Fatalf("%s after close: %d", path, code)
		}
	}
	if code, _ := f.call(t, "POST", "/v1/cells/c1/revoke", nil); code != 404 {
		t.Fatalf("revoke after close: %d", code)
	}
}

func TestBudgetAndModels(t *testing.T) {
	f := newFixture(t)
	code, body := f.call(t, "GET", "/v1/budget", nil)
	if code != 200 || body["perTaskUSD"] != 0.0 || body["perDayUSD"] != 0.0 {
		t.Fatalf("no limits until the user sets them: %d %v", code, body)
	}
	if code, _ := f.call(t, "PUT", "/v1/budget", map[string]any{"perTaskUSD": 50, "perDayUSD": 20}); code != 400 {
		t.Fatalf("task over day: %d", code)
	}
	if code, _ := f.call(t, "PUT", "/v1/budget", map[string]any{"perTaskUSD": 2, "perDayUSD": 10}); code != 200 {
		t.Fatalf("set budget: %d", code)
	}
	models := []map[string]any{{"id": "claude-sonnet-5-5", "inputUSDPerMTok": 3, "outputUSDPerMTok": 15}}
	if code, _ := f.call(t, "PUT", "/v1/llm/routes/anthropic/models", map[string]any{"models": models}); code != 400 {
		t.Fatalf("a priced model without its maximum output: %d", code)
	}
	models[0]["maxOutputTokens"] = 64000
	if code, _ := f.call(t, "PUT", "/v1/llm/routes/anthropic/models", map[string]any{"models": models}); code != 200 {
		t.Fatalf("set models: %d", code)
	}
	code, body = f.call(t, "GET", "/v1/llm/routes/anthropic/models", nil)
	if code != 200 || len(body["models"].([]any)) != 1 || body["models"].([]any)[0].(map[string]any)["maxOutputTokens"] != 64000.0 {
		t.Fatalf("models: %d %v", code, body)
	}
	if code, _ := f.call(t, "PUT", "/v1/llm/routes/Bad Route/models", map[string]any{"models": models}); code != 400 && code != 404 {
		t.Fatalf("bad route: %d", code)
	}
}

func TestEventsStreamAsJSONLines(t *testing.T) {
	f := newFixture(t)
	resp, err := http.Get(f.srv.URL + "/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("content type %q", resp.Header.Get("Content-Type"))
	}
	go func() {
		time.Sleep(50 * time.Millisecond)
		f.s.Events.Publish(events.Event{Type: events.TypeKeyUse, Cell: "c1", Data: events.KeyUse{SecretID: "anthropic", Host: "api.anthropic.com", Method: "POST", Path: "/v1/messages", Decision: "allow"}})
	}()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var e struct {
		Type string `json:"type"`
		Cell string `json:"cell"`
		Data struct {
			SecretID string `json:"secretId"`
			Decision string `json:"decision"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(line), &e); err != nil || e.Type != "key.use" || e.Cell != "c1" || e.Data.SecretID != "anthropic" {
		t.Fatalf("event line %q: %v", line, err)
	}
}
