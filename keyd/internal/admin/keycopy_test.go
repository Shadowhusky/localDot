package admin

import (
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// dot is an in-process keyd for one home: its admin API on <home>/keyd/admin.sock, one memory store
// for its keys and logins, and every request its socket answered.
type dot struct {
	s     *Server
	store *vault.Memory
	home  string
	audit string

	mu       sync.Mutex
	state    string
	refuse   string
	requests []string
}

func newDot(t *testing.T) *dot {
	t.Helper()
	home, err := os.MkdirTemp("", "kd")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(home) })
	dir := filepath.Join(home, "keyd")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	d := &dot{store: vault.NewMemory(), home: home, audit: filepath.Join(dir, "audit.jsonl"), state: "ready"}
	log, _ := audit.Open(d.audit)
	t.Cleanup(func() { log.Close() })
	opener, _ := vault.NewOpener()
	d.s = &Server{Logins: vault.NewLogins(d.store), Opener: opener, Audit: log, Events: events.NewHub(),
		BootID: "boot-" + filepath.Base(home), Version: "test", Home: home,
		VaultState: func() vault.VaultState {
			d.mu.Lock()
			defer d.mu.Unlock()
			return vault.VaultState{Backend: "memory", State: d.state}
		}}
	d.reopen(t)
	ln, err := Listen(filepath.Join(dir, "admin.sock"))
	if err != nil {
		t.Fatal(err)
	}
	api := d.s.Handler()
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.mu.Lock()
		line := r.Method + " " + r.URL.Path
		d.requests = append(d.requests, line)
		refused := d.refuse != "" && strings.HasPrefix(line, d.refuse)
		d.mu.Unlock()
		if refused {
			fail(w, http.StatusInternalServerError, "vault", "the secret could not be stored")
			return
		}
		api.ServeHTTP(w, r)
	})}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return d
}

// reopen gives the dot a vault read afresh from its store and index, as keyd has after a restart.
func (d *dot) reopen(t *testing.T) {
	t.Helper()
	dir := filepath.Join(d.home, "keyd")
	v, err := vault.Open(d.store, filepath.Join(dir, "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	settings, _ := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	budget, _ := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	registry := keys.NewRegistry()
	m := egress.NewManager(egress.ManagerDeps{
		Deps: egress.Deps{
			Registry: registry, Vault: v, Audit: d.s.Audit, Events: d.s.Events, Budget: budget, Settings: settings,
			Dialer: &netguard.Dialer{Guard: netguard.New(netguard.InterfacePrefixes), Resolver: &noResolver{}},
		},
		CellsDir: filepath.Join(dir, "cells"),
	})
	t.Cleanup(m.CloseAll)
	d.s.Manager, d.s.Vault, d.s.Registry, d.s.Settings, d.s.Budget = m, v, registry, settings, budget
}

func (d *dot) set(state, refuse string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.state, d.refuse = state, refuse
}

func (d *dot) seen() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.requests...)
}

func (d *dot) call(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	raw, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	d.s.Handler().ServeHTTP(rec, httptest.NewRequest(method, path, bytes.NewReader(raw)))
	var out map[string]any
	json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func (d *dot) put(t *testing.T, id string, fields map[string]any, value string) {
	t.Helper()
	sealed, err := vault.Seal(d.s.Opener.PublicKey(), record(id, fields), []byte(value))
	if err != nil {
		t.Fatal(err)
	}
	fields["sealed"] = sealed
	if code, body := d.call(t, "PUT", "/v1/secrets/"+id, fields); code != 200 {
		t.Fatalf("put %s: %d %v", id, code, body)
	}
}

func errorCode(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	code, _ := e["code"].(string)
	return code
}

var acceptPeer = func(*net.UnixConn) error { return nil }

const noteValue = "a general secret\nwith a line break"

// keys is a source dot holding a web key with a description, a general secret and a saved login.
func keysDot(t *testing.T) *dot {
	t.Helper()
	d := newDot(t)
	web := weather()
	web["metadata"] = map[string]any{"label": "Weather", "description": "Forecasts for trips"}
	d.put(t, "weather", web, fakeKey)
	d.put(t, "note", map[string]any{"kind": "secret"}, noteValue)
	if err := d.s.Logins.Put("https://github.com", vault.Login{Username: "fixture-user", Password: "fixture password"}); err != nil {
		t.Fatal(err)
	}
	return d
}

func TestKeysCopyGivesAnotherDotsKeydTheKeysSealedToIt(t *testing.T) {
	src, dst := keysDot(t), newDot(t)
	src.s.VerifyPeer = acceptPeer
	code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": dst.home})
	if code != 200 || body["secrets"] != 2.0 || body["logins"] != 1.0 || body["skipped"] != 0.0 {
		t.Fatalf("copy: %d %v", code, body)
	}
	for id, want := range map[string]string{"weather": fakeKey, "note": noteValue} {
		got, err := dst.s.Vault.Value(id)
		if err != nil || string(got) != want {
			t.Fatalf("%s reads %q, %v", id, got, err)
		}
		before, _ := src.s.Vault.Record(id)
		after, _ := dst.s.Vault.Record(id)
		before.CreatedAt, before.UpdatedAt, after.CreatedAt, after.UpdatedAt = time.Time{}, time.Time{}, time.Time{}, time.Time{}
		a, _ := json.Marshal(before)
		b, _ := json.Marshal(after)
		if !bytes.Equal(a, b) {
			t.Fatalf("%s arrived as %s, want %s", id, b, a)
		}
	}
	login, err := dst.s.Logins.Get("https://github.com")
	if err != nil || login.Username != "fixture-user" || login.Password != "fixture password" {
		t.Fatalf("login = %+v, %v", login, err)
	}
	if origins, _ := dst.s.Logins.List(); len(origins) != 1 {
		t.Fatalf("the copied login is not listed: %v", origins)
	}
	if got := strings.Join(dst.seen(), ","); got != "GET /v1/status,PUT /v1/secrets/note,PUT /v1/secrets/weather,PUT /v1/logins" {
		t.Fatalf("the other dot saw %s", got)
	}
	trail, _ := os.ReadFile(src.audit)
	if !strings.Contains(string(trail), `"reason":"keys-copy"`) || strings.Contains(string(trail), fakeKey) || strings.Contains(string(trail), "fixture password") {
		t.Fatalf("audit: %s", trail)
	}
	if code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": dst.home, "logins": false}); code != 200 || body["logins"] != 0.0 {
		t.Fatalf("copy without logins: %d %v", code, body)
	}
}

func TestKeysCopySendsNothingToAPeerThatIsNotKeyd(t *testing.T) {
	src, dst := keysDot(t), newDot(t)
	checks := 0
	for _, failAt := range []int{1, 2} {
		checks = 0
		src.s.VerifyPeer = func(*net.UnixConn) error {
			checks++
			if checks == failAt {
				return vault.ErrNotKeyd
			}
			return nil
		}
		code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": dst.home})
		if code != http.StatusForbidden || errorCode(body) != "not-keyd" {
			t.Fatalf("check %d: %d %v", failAt, code, body)
		}
	}
	if got := strings.Join(dst.seen(), ","); got != "GET /v1/status" {
		t.Fatalf("a peer that is not keyd saw %s", got)
	}
	if len(dst.s.Vault.Records()) != 0 {
		t.Fatal("a key reached a peer that is not keyd")
	}
	trail, _ := os.ReadFile(src.audit)
	if !strings.Contains(string(trail), `"decision":"deny","reason":"keys-copy"`) {
		t.Fatalf("audit: %s", trail)
	}
}

func TestKeysCopyWaitsForTheOtherDotsUnlock(t *testing.T) {
	src, dst := keysDot(t), newDot(t)
	src.s.VerifyPeer = acceptPeer
	for _, state := range []string{"locked", "setup"} {
		dst.set(state, "")
		code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": dst.home})
		if code != http.StatusConflict || errorCode(body) != "receiver-locked" {
			t.Fatalf("%s: %d %v", state, code, body)
		}
	}
	if got := strings.Join(dst.seen(), ","); got != "GET /v1/status,GET /v1/status" {
		t.Fatalf("a locked dot saw %s", got)
	}
	src.set("locked", "")
	dst.set("ready", "")
	if code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": dst.home}); code != http.StatusLocked || errorCode(body) != "vault-locked" {
		t.Fatalf("own vault locked: %d %v", code, body)
	}
}

func TestKeysCopyNamesOnlyAnotherDotsHome(t *testing.T) {
	src := keysDot(t)
	src.s.VerifyPeer = func(*net.UnixConn) error {
		t.Fatal("a refused home was dialled")
		return nil
	}
	link := filepath.Join(t.TempDir(), "same")
	if err := os.Symlink(src.home, link); err != nil {
		t.Fatal(err)
	}
	for _, home := range []string{src.home, link, "", "relative/home", src.home + "/../" + filepath.Base(src.home), "/tmp/" + strings.Repeat("h", 100), "/tmp/a\nb"} {
		if code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": home}); code != http.StatusBadRequest {
			t.Fatalf("%q: %d %v", home, code, body)
		}
	}
	if code, _ := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": src.home, "key": "x"}); code != http.StatusBadRequest {
		t.Fatal("a caller-supplied field was accepted")
	}
	empty, err := os.MkdirTemp("", "kd")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(empty)
	src.s.VerifyPeer = acceptPeer
	if code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": empty}); code != http.StatusBadGateway || errorCode(body) != "unreachable" {
		t.Fatalf("no key service: %d %v", code, body)
	}
}

func TestKeysCopyCountsWhatItCouldNotReadAndStopsAtARefusal(t *testing.T) {
	src, dst := keysDot(t), newDot(t)
	src.s.VerifyPeer = acceptPeer
	if err := src.store.Delete("note"); err != nil {
		t.Fatal(err)
	}
	src.reopen(t)
	code, body := src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": dst.home})
	if code != 200 || body["secrets"] != 1.0 || body["skipped"] != 1.0 {
		t.Fatalf("copy: %d %v", code, body)
	}
	dst.set("ready", "PUT /v1/secrets/")
	code, body = src.call(t, "POST", "/v1/keys/copy", map[string]any{"home": dst.home})
	if code != http.StatusBadGateway || errorCode(body) != "receiver-refused" {
		t.Fatalf("refused: %d %v", code, body)
	}
	if message := body["error"].(map[string]any)["message"].(string); strings.Contains(message, "could not be stored") {
		t.Fatalf("the other dot's error reached the caller: %s", message)
	}
}

func TestForgetLeavesTheDotsVaultEmpty(t *testing.T) {
	d := keysDot(t)
	for _, body := range []any{map[string]any{}, map[string]any{"confirm": "yes"}, map[string]any{"confirm": "forget", "all": true}} {
		if code, _ := d.call(t, "POST", "/v1/vault/forget", body); code != http.StatusBadRequest {
			t.Fatalf("%v: %d", body, code)
		}
	}
	d.set("locked", "")
	if code, body := d.call(t, "POST", "/v1/vault/forget", map[string]any{"confirm": "forget"}); code != http.StatusLocked || errorCode(body) != "vault-locked" {
		t.Fatalf("locked: %d %v", code, body)
	}
	d.set("ready", "")
	if err := d.store.Put(vault.PushKeyID, []byte("push key value"), strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	code, body := d.call(t, "POST", "/v1/vault/forget", map[string]any{"confirm": "forget"})
	if code != 200 || body["secrets"] != 2.0 || body["logins"] != 1.0 {
		t.Fatalf("forget: %d %v", code, body)
	}
	if len(d.s.Vault.Records()) != 0 {
		t.Fatal("records survived")
	}
	for _, id := range []string{"weather", "note", vault.PushKeyID} {
		if _, err := d.store.Get(id, strings.Repeat("a", 64)); !errors.Is(err, vault.ErrNotFound) {
			t.Fatalf("%s survived: %v", id, err)
		}
	}
	if _, err := d.s.Logins.Get("https://github.com"); !errors.Is(err, vault.ErrNotFound) {
		t.Fatalf("the login survived: %v", err)
	}
	trail, _ := os.ReadFile(d.audit)
	if !strings.Contains(string(trail), `"reason":"vault-forget"`) {
		t.Fatalf("audit: %s", trail)
	}
	if code, body := d.call(t, "GET", "/v1/status", nil); code != 200 || body["keyCopy"] != true || body["vaultForget"] != true {
		t.Fatalf("status: %d %v", code, body)
	}
}
