package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/oauth"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	appHost   = "mcp.app.example.test"
	authHost  = "auth.app.example.test"
	secretID  = "connector-app"
	verifier  = "verifier-0123456789-0123456789-0123456789-0123"
	loopback  = "http://127.0.0.1:4750/connectors/callback"
	clientURL = "https://localdot.example.test/oauth/client-metadata.json"
)

// issuer is an app's sign-in service: it redeems codes, rotates refresh tokens as strictly as the
// specification asks for public clients (an old one is refused) and records what it was sent.
type issuer struct {
	mu        sync.Mutex
	serial    int
	refresh   string
	refreshes int
	rotate    bool
	omit      bool
	expiresIn int
	status    int
	errorCode string
	gate      chan struct{}
	forms     []url.Values
	revoked   []url.Values
	location  string
}

func (i *issuer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	i.mu.Lock()
	gate := i.gate
	i.mu.Unlock()
	if gate != nil {
		<-gate
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if r.URL.Path == "/revoke" {
		i.revoked = append(i.revoked, r.PostForm)
		return
	}
	i.forms = append(i.forms, r.PostForm)
	if i.location != "" {
		w.Header().Set("Location", i.location)
		w.WriteHeader(http.StatusFound)
		return
	}
	if i.status != 0 {
		w.WriteHeader(i.status)
		if i.errorCode != "" {
			json.NewEncoder(w).Encode(map[string]string{"error": i.errorCode})
		}
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		if r.PostForm.Get("code") != "the-code" || r.PostForm.Get("code_verifier") != verifier || r.PostForm.Get("redirect_uri") != loopback {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
			return
		}
	case "refresh_token":
		i.refreshes++
		if r.PostForm.Get("refresh_token") != i.refresh {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
			return
		}
	default:
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	i.serial++
	reply := map[string]any{"access_token": fmt.Sprintf("access-token-%d", i.serial), "token_type": "Bearer"}
	if i.expiresIn != 0 {
		reply["expires_in"] = i.expiresIn
	}
	if !i.omit && (i.rotate || i.refresh == "") {
		i.refresh = fmt.Sprintf("refresh-token-%d", i.serial)
		reply["refresh_token"] = i.refresh
	}
	if i.serial == 1 {
		reply["email"] = "ada@example.test"
	}
	json.NewEncoder(w).Encode(reply)
}

func (i *issuer) set(change func(*issuer)) {
	i.mu.Lock()
	defer i.mu.Unlock()
	change(i)
}

func (i *issuer) count() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.refreshes
}

type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// signedIn is a keyd with a signed-in app: its connector cell open, a surrogate in hand.
type signedIn struct {
	t         *testing.T
	w         *world
	m         *Manager
	tokens    *oauth.Broker
	store     vault.Store
	clock     *clock
	issuer    *issuer
	client    *http.Client
	surrogate string
	seen      *seenTokens
	index     string
}

type seenTokens struct {
	mu     sync.Mutex
	tokens []string
	echo   atomic.Pointer[string]
}

func (s *seenTokens) last() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.tokens) == 0 {
		return ""
	}
	return s.tokens[len(s.tokens)-1]
}

func newSignedIn(t *testing.T, configure func(*issuer)) *signedIn {
	t.Helper()
	w := newWorld(t)
	dir := t.TempDir()
	settings, _ := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	budget, _ := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	store := vault.NewMemory()
	index := filepath.Join(dir, "secrets.json")
	v, err := vault.Open(store, index)
	if err != nil {
		t.Fatal(err)
	}
	w.vault = v
	s := &signedIn{t: t, w: w, store: store, index: index, clock: &clock{now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)},
		issuer: &issuer{rotate: true, expiresIn: 3600}, seen: &seenTokens{}}
	if configure != nil {
		configure(s.issuer)
	}
	w.tlsUpstream(authHost, s.issuer)
	w.tlsUpstream(appHost, http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		s.seen.mu.Lock()
		s.seen.tokens = append(s.seen.tokens, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		s.seen.mu.Unlock()
		if echo := s.seen.echo.Load(); echo != nil {
			rw.Write([]byte(*echo))
		}
	}))
	s.tokens = oauth.New(oauth.Deps{Store: store, Vault: v, Client: oauth.Client(portMap{w}.DialContext, w.roots()), Audit: w.audit, Now: s.clock.Now})
	t.Cleanup(s.tokens.Close)
	deps := w.deps()
	deps.Budget, deps.Settings, deps.Tokens = budget, settings, s.tokens
	s.m = NewManager(ManagerDeps{Deps: deps, Ports: PortRange{}, CellsDir: filepath.Join(dir, "cells")})
	t.Cleanup(s.m.CloseAll)
	if err := s.connect(); err != nil {
		t.Fatal(err)
	}
	s.open()
	return s
}

func (s *signedIn) connect() error {
	rec := vault.Record{ID: secretID, Kind: vault.KindHTTP, Hosts: []string{appHost}, Header: "Authorization", Format: "bearer"}
	grant := oauth.Grant{TokenEndpoint: "https://" + authHost + "/token", RevocationEndpoint: "https://" + authHost + "/revoke", ClientID: clientURL,
		Resource: "https://" + appHost + "/mcp", Code: "the-code", CodeVerifier: verifier, RedirectURI: loopback}
	return s.tokens.Connect(context.Background(), rec, grant, func(rec vault.Record, value []byte) error {
		_, err := s.m.PutSecret(rec, value)
		return err
	})
}

func (s *signedIn) open() {
	s.t.Helper()
	o, err := s.m.Open(OpenRequest{CellID: "connector-app", Role: "connector", Secrets: []string{secretID}})
	if err != nil {
		s.t.Fatal(err)
	}
	s.surrogate = o.Surrogates[secretID]
	s.client = cellClient(s.w, o)
}

func (s *signedIn) call() (*http.Response, string) {
	s.t.Helper()
	return do(s.t, s.client, "POST", "https://"+appHost+"/mcp", http.Header{"Authorization": {"Bearer " + s.surrogate}})
}

func (s *signedIn) status() *vault.OAuthStatus {
	s.t.Helper()
	rec, ok := s.w.vault.Record(secretID)
	if !ok {
		s.t.Fatal("the secret is gone")
	}
	return rec.OAuth
}

func TestASignInRefreshesBehindItsSurrogateAndRotates(t *testing.T) {
	s := newSignedIn(t, nil)
	if status := s.status(); !status.Refreshes || status.Account != "ada@example.test" || status.ExpiresAt.IsZero() {
		t.Fatalf("status %+v", status)
	}
	surrogate := s.surrogate
	if resp, _ := s.call(); resp.StatusCode != 200 || s.seen.last() != "access-token-1" {
		t.Fatalf("%d, the app saw %q", resp.StatusCode, s.seen.last())
	}
	if s.issuer.count() != 0 {
		t.Fatal("a token with time left was refreshed")
	}

	s.clock.advance(59*time.Minute + time.Second)
	if resp, _ := s.call(); resp.StatusCode != 200 || s.seen.last() != "access-token-2" {
		t.Fatalf("%d, the app saw %q", resp.StatusCode, s.seen.last())
	}
	if s.surrogate != surrogate {
		t.Fatal("the surrogate changed")
	}
	form := s.issuer.forms[len(s.issuer.forms)-1]
	if form.Get("refresh_token") != "refresh-token-1" || form.Get("client_id") != clientURL || form.Get("resource") != "https://"+appHost+"/mcp" {
		t.Fatalf("refresh sent %v", form)
	}
	if status := s.status(); status.Account != "ada@example.test" {
		t.Fatalf("the account was lost: %+v", status)
	}

	s.clock.advance(59*time.Minute + time.Second)
	if resp, _ := s.call(); resp.StatusCode != 200 || s.seen.last() != "access-token-3" {
		t.Fatalf("%d, the app saw %q", resp.StatusCode, s.seen.last())
	}
	form = s.issuer.forms[len(s.issuer.forms)-1]
	if form.Get("refresh_token") != "refresh-token-2" {
		t.Fatalf("the rotated token was not used: %v", form)
	}
}

func TestARefreshIsOneHoweverManyAsk(t *testing.T) {
	s := newSignedIn(t, nil)
	s.clock.advance(59*time.Minute + time.Second)
	gate := make(chan struct{})
	s.issuer.set(func(i *issuer) { i.gate = gate })
	var wg sync.WaitGroup
	statuses := make([]int, 16)
	for n := range statuses {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req, _ := http.NewRequest("POST", "https://"+appHost+"/mcp", nil)
			req.Header.Set("Authorization", "Bearer "+s.surrogate)
			resp, err := s.client.Do(req)
			if err == nil {
				statuses[n] = resp.StatusCode
				resp.Body.Close()
			}
		}()
	}
	time.Sleep(100 * time.Millisecond)
	s.issuer.set(func(i *issuer) { i.gate = nil })
	close(gate)
	wg.Wait()
	for n, status := range statuses {
		if status != 200 {
			t.Fatalf("request %d: %d", n, status)
		}
	}
	if got := s.issuer.count(); got != 1 {
		t.Fatalf("%d refreshes", got)
	}
	for _, token := range s.seen.tokens {
		if token != "access-token-2" {
			t.Fatalf("a request carried %q", token)
		}
	}
}

func TestARevokedSignInAsksToReconnectWithoutCallingTheApp(t *testing.T) {
	s := newSignedIn(t, nil)
	s.clock.advance(59*time.Minute + time.Second)
	s.issuer.set(func(i *issuer) { i.status, i.errorCode = http.StatusBadRequest, "invalid_grant" })
	calls := len(s.seen.tokens)
	resp, _ := s.call()
	if resp.StatusCode != http.StatusUnauthorized || resp.Header.Get("X-Keyd-Reason") != ReasonReconnect || resp.Header.Get("X-Keyd-Secret") != secretID {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	if !s.status().Reconnect {
		t.Fatalf("status %+v", s.status())
	}
	if len(s.seen.tokens) != calls {
		t.Fatal("the app was called with a finished sign-in")
	}
	before := len(s.issuer.forms)
	s.call()
	if len(s.issuer.forms) != before {
		t.Fatal("a finished sign-in was refreshed again")
	}
	// A new sign-in starts over.
	s.issuer.set(func(i *issuer) { i.status, i.errorCode, i.refresh = 0, "", "" })
	if err := s.connect(); err != nil {
		t.Fatal(err)
	}
	if err := s.m.Close("connector-app"); err != nil {
		t.Fatal(err)
	}
	s.open()
	if resp, _ := s.call(); resp.StatusCode != 200 || s.status().Reconnect {
		t.Fatalf("%d %+v", resp.StatusCode, s.status())
	}
}

func TestASignInServiceThatIsDownIsNotASignInThatEnded(t *testing.T) {
	s := newSignedIn(t, nil)
	s.issuer.set(func(i *issuer) { i.status = http.StatusBadGateway })
	// In the last minute the token is still good: the request goes with it.
	s.clock.advance(59*time.Minute + time.Second)
	if resp, _ := s.call(); resp.StatusCode != 200 || s.seen.last() != "access-token-1" {
		t.Fatalf("%d, the app saw %q", resp.StatusCode, s.seen.last())
	}
	tried := len(s.issuer.forms)
	s.call()
	if len(s.issuer.forms) != tried {
		t.Fatal("the failed service was asked again at once")
	}
	// Past its end, with the service still down, nothing is sent and the sign-in stands.
	s.clock.advance(2 * time.Minute)
	resp, _ := s.call()
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != ReasonOAuthDown {
		t.Fatalf("%d %v", resp.StatusCode, resp.Header)
	}
	if s.status().Reconnect {
		t.Fatal("a passing failure ended the sign-in")
	}
	s.clock.advance(time.Minute)
	s.issuer.set(func(i *issuer) { i.status = 0 })
	if resp, _ := s.call(); resp.StatusCode != 200 || s.seen.last() != "access-token-2" {
		t.Fatalf("%d, the app saw %q", resp.StatusCode, s.seen.last())
	}
}

func TestADisconnectOvertakesARefreshInFlight(t *testing.T) {
	s := newSignedIn(t, nil)
	s.clock.advance(59*time.Minute + time.Second)
	gate := make(chan struct{})
	s.issuer.set(func(i *issuer) { i.gate = gate })
	result := make(chan error, 1)
	go func() { result <- s.tokens.Renew(context.Background(), secretID) }()
	time.Sleep(50 * time.Millisecond)
	s.tokens.Forget(secretID)
	if _, err := s.m.DeleteSecret(secretID); err != nil {
		t.Fatal(err)
	}
	s.issuer.set(func(i *issuer) { i.gate = nil })
	close(gate)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if _, ok := s.w.vault.Record(secretID); ok {
		t.Fatal("the refresh brought the removed secret back")
	}
	item, binding := vault.OAuthItem(secretID)
	if _, err := s.store.Get(item, binding); !errors.Is(err, vault.ErrNotFound) {
		t.Fatalf("the refresh token stayed: %v", err)
	}
	// Both the token it held and the one the overtaken refresh was given end at the app.
	deadline := time.Now().Add(3 * time.Second)
	var revoked []string
	for time.Now().Before(deadline) && len(revoked) < 2 {
		s.issuer.set(func(i *issuer) {
			revoked = revoked[:0]
			for _, form := range i.revoked {
				revoked = append(revoked, form.Get("token"))
			}
		})
		time.Sleep(10 * time.Millisecond)
	}
	if !strings.Contains(strings.Join(revoked, " "), "refresh-token-1") || !strings.Contains(strings.Join(revoked, " "), "refresh-token-2") {
		t.Fatalf("revoked %v", revoked)
	}
}

func TestANewSignInOvertakesARefreshInFlight(t *testing.T) {
	s := newSignedIn(t, nil)
	s.clock.advance(59*time.Minute + time.Second)
	gate := make(chan struct{})
	s.issuer.set(func(i *issuer) { i.gate = gate })
	result := make(chan error, 1)
	go func() { result <- s.tokens.Renew(context.Background(), secretID) }()
	time.Sleep(50 * time.Millisecond)
	// The sign-in redeems its code around the refresh, so it lands last.
	s.issuer.set(func(i *issuer) { i.gate = nil })
	close(gate)
	connected := make(chan error, 1)
	go func() { connected <- s.connect() }()
	if err := <-connected; err != nil {
		t.Fatal(err)
	}
	<-result
	value, err := s.w.vault.Value(secretID)
	if err != nil || !strings.HasPrefix(string(value), "access-token-") {
		t.Fatalf("%q %v", value, err)
	}
}

func TestAConnectionFromBeforeRefreshKeepsWorkingUntilItsAppRefusesIt(t *testing.T) {
	s := newSignedIn(t, nil)
	s.w.secret(vault.Record{ID: "connector-old", Kind: vault.KindHTTP, Hosts: []string{"old.example.test"}, Header: "Authorization", Format: "bearer"}, "old-access-token")
	s.w.tlsUpstream("old.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer old-access-token" {
			rw.WriteHeader(http.StatusForbidden)
		}
	}))
	o, err := s.m.Open(OpenRequest{CellID: "connector-old", Role: "connector", Secrets: []string{"connector-old"}})
	if err != nil {
		t.Fatal(err)
	}
	s.clock.advance(1000 * time.Hour)
	resp, _ := do(t, cellClient(s.w, o), "POST", "https://old.example.test/mcp", http.Header{"Authorization": {"Bearer " + o.Surrogates["connector-old"]}})
	if resp.StatusCode != 200 {
		t.Fatalf("%d", resp.StatusCode)
	}
	if err := s.tokens.Renew(context.Background(), "connector-old"); !errors.Is(err, oauth.ErrNotSignedIn) {
		t.Fatalf("%v", err)
	}
}

func TestAnAppThatGivesNoRefreshTokenAsksToReconnectAtItsEnd(t *testing.T) {
	s := newSignedIn(t, func(i *issuer) { i.omit = true })
	if s.status().Refreshes {
		t.Fatalf("%+v", s.status())
	}
	if resp, _ := s.call(); resp.StatusCode != 200 {
		t.Fatalf("%d", resp.StatusCode)
	}
	s.clock.advance(time.Hour)
	resp, _ := s.call()
	if resp.StatusCode != http.StatusUnauthorized || !s.status().Reconnect {
		t.Fatalf("%d %+v", resp.StatusCode, s.status())
	}
}

func TestATokenWithNoStatedEndIsRefreshedWhenItsAppRefusesIt(t *testing.T) {
	s := newSignedIn(t, func(i *issuer) { i.expiresIn = 0 })
	if s.status().RefreshAt != (time.Time{}) {
		t.Fatalf("%+v", s.status())
	}
	s.clock.advance(1000 * time.Hour)
	if resp, _ := s.call(); resp.StatusCode != 200 || s.issuer.count() != 0 {
		t.Fatalf("%d after %d refreshes", resp.StatusCode, s.issuer.count())
	}
	if err := s.tokens.Renew(context.Background(), secretID); err != nil {
		t.Fatal(err)
	}
	if s.issuer.count() != 1 {
		t.Fatalf("%d refreshes", s.issuer.count())
	}
	// Everyone the app just refused says so; one refresh answers them all.
	if err := s.tokens.Renew(context.Background(), secretID); err != nil || s.issuer.count() != 1 {
		t.Fatalf("%v after %d refreshes", err, s.issuer.count())
	}
	if resp, _ := s.call(); resp.StatusCode != 200 || s.seen.last() != "access-token-2" {
		t.Fatalf("%d, the app saw %q", resp.StatusCode, s.seen.last())
	}
}

func TestAnEchoOfTheTokenIsScrubbedAfterARefreshToo(t *testing.T) {
	s := newSignedIn(t, nil)
	s.call()
	s.clock.advance(59*time.Minute + time.Second)
	both := "was access-token-1 now access-token-2"
	s.seen.echo.Store(&both)
	_, body := s.call()
	if s.seen.last() != "access-token-2" {
		t.Fatalf("the app saw %q", s.seen.last())
	}
	if strings.Contains(body, "access-token-") || !strings.Contains(body, s.surrogate) {
		t.Fatalf("the reply read %q", body)
	}
}

func TestARefreshTokenStaysOutOfEverythingButTheStore(t *testing.T) {
	s := newSignedIn(t, nil)
	s.clock.advance(59*time.Minute + time.Second)
	s.call()
	rec, _ := s.w.vault.Record(secretID)
	listed, _ := json.Marshal(rec)
	if strings.Contains(string(listed), "refresh-token") || strings.Contains(string(listed), "access-token") {
		t.Fatalf("the record holds a token: %s", listed)
	}
	data, err := os.ReadFile(s.w.auditPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "refresh-token") || strings.Contains(string(data), "access-token") {
		t.Fatal("the audit log holds a token")
	}
	if !strings.Contains(string(data), "oauth-refresh") {
		t.Fatal("the refresh was not audited")
	}
	item, binding := vault.OAuthItem(secretID)
	raw, err := s.store.Get(item, binding)
	if err != nil || !strings.Contains(string(raw), "refresh-token-2") {
		t.Fatalf("%s %v", raw, err)
	}
}

func TestARestartedKeydKeepsTheSignIn(t *testing.T) {
	s := newSignedIn(t, nil)
	s.clock.advance(59*time.Minute + time.Second)
	s.call()
	// The store and the index are all that survive a restart.
	reopened, err := vault.Open(s.store, s.index)
	if err != nil {
		t.Fatal(err)
	}
	rec, ok := reopened.Record(secretID)
	if !ok || rec.OAuth == nil || !rec.OAuth.Refreshes {
		t.Fatalf("%+v", rec)
	}
	tokens := oauth.New(oauth.Deps{Store: s.store, Vault: reopened, Client: oauth.Client(portMap{s.w}.DialContext, s.w.roots()), Now: s.clock.Now})
	t.Cleanup(tokens.Close)
	s.clock.advance(time.Hour)
	if err := tokens.Fresh(context.Background(), secretID); err != nil {
		t.Fatal(err)
	}
	value, err := reopened.Value(secretID)
	if err != nil || string(value) != "access-token-3" {
		t.Fatalf("%q %v", value, err)
	}
}

func TestATokenEndpointsRedirectIsNotFollowed(t *testing.T) {
	s := newSignedIn(t, nil)
	var taken atomic.Int32
	s.w.tlsUpstream("elsewhere.example.test", http.HandlerFunc(func(http.ResponseWriter, *http.Request) { taken.Add(1) }))
	s.issuer.set(func(i *issuer) { i.location = "https://elsewhere.example.test/steal" })
	if err := s.tokens.Renew(context.Background(), secretID); !errors.Is(err, oauth.ErrUnavailable) && err != nil {
		t.Fatal(err)
	}
	if taken.Load() != 0 {
		t.Fatal("the refresh token followed a redirect")
	}
}
