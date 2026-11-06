// Package oauth keeps signed-in apps connected. keyd redeems a sign-in's code itself and keeps the
// refresh token in its store, so no token passes through the daemon. It refreshes the access token
// as the token nears its end, behind the surrogate a cell already holds: the token the app gets
// changes and nothing else does.
package oauth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	callTimeout   = 15 * time.Second
	revokeTimeout = 5 * time.Second
	maxReply      = 1 << 20
	// A token is refreshed this long before its end, or a quarter of its life if that is less.
	refreshLead = time.Minute
	// After a refresh the sign-in service failed, the requests behind it don't each try again.
	retryHold = 15 * time.Second
	// A token refused again this soon after a refresh is not refreshed again.
	renewGap   = 30 * time.Second
	maxAccount = 80
	// What the longest token may be stored as, with room for what it is stored beside.
	maxStateBytes = 8192
)

var (
	// ErrReconnect: the app ended this sign-in. Only the user signing in again helps.
	ErrReconnect = errors.New("oauth: the user has to sign in again")
	// ErrUnavailable: the app's sign-in service did not answer. Trying later may help.
	ErrUnavailable = errors.New("oauth: the sign-in service did not answer")
	// ErrNotSignedIn: keyd keeps no sign-in for this secret.
	ErrNotSignedIn = errors.New("oauth: no sign-in for this secret")

	errorCode = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
	// What a token endpoint says when the grant itself is finished, as opposed to a passing failure.
	finished = []string{"invalid_grant", "invalid_client", "unauthorized_client", "unsupported_grant_type"}
)

// BadGrantError is a sign-in keyd refuses without calling anyone.
type BadGrantError struct{ msg string }

func (e *BadGrantError) Error() string { return "oauth: " + e.msg }

// RefusedError is a token endpoint's own refusal, by its OAuth error code.
type RefusedError struct{ Code string }

func (e *RefusedError) Error() string { return "oauth: the app refused: " + e.Code }

// Grant is what a finished sign-in hands keyd: the code the app sent back, and where and how to
// redeem it. The endpoints come from the app's own metadata, so this path reaches only the app's
// sign-in service, through keyd's guarded dialer.
type Grant struct {
	TokenEndpoint      string `json:"tokenEndpoint"`
	RevocationEndpoint string `json:"revocationEndpoint,omitempty"`
	ClientID           string `json:"clientId"`
	ClientSecret       string `json:"clientSecret,omitempty"`
	AuthMethod         string `json:"authMethod,omitempty"`
	Resource           string `json:"resource,omitempty"`
	Code               string `json:"code"`
	CodeVerifier       string `json:"codeVerifier"`
	RedirectURI        string `json:"redirectUri"`
}

// state is the store item beside a signed-in secret: the refresh token and the one place it goes.
type state struct {
	RefreshToken       string `json:"refreshToken,omitempty"`
	TokenEndpoint      string `json:"tokenEndpoint"`
	RevocationEndpoint string `json:"revocationEndpoint,omitempty"`
	ClientID           string `json:"clientId"`
	ClientSecret       string `json:"clientSecret,omitempty"`
	AuthMethod         string `json:"authMethod,omitempty"`
	Resource           string `json:"resource,omitempty"`
}

type Deps struct {
	Store  vault.Store
	Vault  *vault.Vault
	Client *http.Client
	Audit  *audit.Log
	// Now is the clock; nil means time.Now.
	Now func() time.Time
}

type flight struct {
	done chan struct{}
	err  error
}

// Broker is safe for concurrent use. commit orders every change to a secret's sign-in, and epochs
// let a refresh that was overtaken by a disconnect or a new sign-in see that and leave them be.
type Broker struct {
	d       Deps
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	commit  sync.Mutex
	mu      sync.Mutex
	flights map[string]*flight
	epochs  map[string]uint64
	holds   map[string]time.Time
	renewed map[string]time.Time
}

func New(d Deps) *Broker {
	if d.Now == nil {
		d.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Broker{d: d, ctx: ctx, cancel: cancel, flights: map[string]*flight{}, epochs: map[string]uint64{},
		holds: map[string]time.Time{}, renewed: map[string]time.Time{}}
}

// Close ends what is in flight and waits for it.
func (b *Broker) Close() {
	b.cancel()
	b.wg.Wait()
}

// Client dials only through dial (keyd's guarded dialer), verifies TLS against roots (nil means the
// system's) and follows no redirect, so a refresh token goes to its token endpoint and nowhere else.
func Client(dial func(ctx context.Context, network, address string) (net.Conn, error), roots *x509.CertPool) *http.Client {
	return &http.Client{
		Timeout: callTimeout,
		Transport: &http.Transport{
			DialContext:         dial,
			Proxy:               nil,
			ForceAttemptHTTP2:   true,
			TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots},
			DisableKeepAlives:   true,
			TLSHandshakeTimeout: callTimeout,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// validEndpoint reports whether raw is an https address at the default port of a public host name.
func validEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	if port := u.Port(); port != "" && port != "443" {
		return false
	}
	return policy.ValidBindingHost(u.Hostname()) == nil
}

func printable(s string, limit int) bool {
	if len(s) > limit {
		return false
	}
	return !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r > 0x7e })
}

func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.User != nil || u.Fragment != "" {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1")
}

func (g Grant) check() error {
	switch {
	case !validEndpoint(g.TokenEndpoint):
		return &BadGrantError{"the token endpoint is not a public https address"}
	case g.RevocationEndpoint != "" && !validEndpoint(g.RevocationEndpoint):
		return &BadGrantError{"the revocation endpoint is not a public https address"}
	case g.ClientID == "" || !printable(g.ClientID, 2048):
		return &BadGrantError{"invalid client id"}
	case !printable(g.ClientSecret, 2048):
		return &BadGrantError{"invalid client secret"}
	case !slices.Contains([]string{"", "none", "client_secret_post", "client_secret_basic"}, g.AuthMethod):
		return &BadGrantError{"unknown client authentication"}
	case g.Resource != "" && !validEndpoint(g.Resource):
		return &BadGrantError{"the resource is not a public https address"}
	case g.Code == "" || !printable(g.Code, 8192):
		return &BadGrantError{"invalid code"}
	case len(g.CodeVerifier) < 43 || !printable(g.CodeVerifier, 128):
		return &BadGrantError{"invalid code verifier"}
	case !validRedirect(g.RedirectURI):
		return &BadGrantError{"invalid redirect address"}
	}
	return nil
}

// Connect redeems the code at the app's token endpoint and keeps what comes back. put stores the
// access token as rec, replacing any secret of that id and ending its surrogates.
func (b *Broker) Connect(ctx context.Context, rec vault.Record, g Grant, put func(vault.Record, []byte) error) error {
	if err := g.check(); err != nil {
		return err
	}
	st := state{TokenEndpoint: g.TokenEndpoint, RevocationEndpoint: g.RevocationEndpoint, ClientID: g.ClientID,
		ClientSecret: g.ClientSecret, AuthMethod: g.AuthMethod, Resource: g.Resource}
	reply, err := b.post(ctx, st, url.Values{"grant_type": {"authorization_code"}, "code": {g.Code},
		"redirect_uri": {g.RedirectURI}, "code_verifier": {g.CodeVerifier}})
	if err != nil {
		return err
	}
	st.RefreshToken = reply.refresh
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if len(raw) > maxStateBytes {
		st.RefreshToken = ""
		if raw, err = json.Marshal(st); err != nil {
			return err
		}
	}
	rec = rec.Clone()
	rec.OAuth = b.statusOf(reply, st.RefreshToken != "", "")
	b.commit.Lock()
	defer b.commit.Unlock()
	b.bump(rec.ID)
	item, binding := vault.OAuthItem(rec.ID)
	if err := b.d.Store.Put(item, raw, binding); err != nil {
		return err
	}
	if err := put(rec, []byte(reply.access)); err != nil {
		_ = b.d.Store.Delete(item)
		return err
	}
	b.mu.Lock()
	delete(b.holds, rec.ID)
	b.renewed[rec.ID] = b.d.Now()
	b.mu.Unlock()
	b.note(rec.ID, audit.Allow, "oauth-connect", hostOf(g.TokenEndpoint))
	return nil
}

// Fresh makes sure the secret's access token is good to send. It does nothing for a secret keyd
// keeps no sign-in for, and that is every saved key and every connection made before keyd kept any:
// those are used until their app refuses them.
func (b *Broker) Fresh(ctx context.Context, id string) error {
	rec, ok := b.d.Vault.Record(id)
	if !ok || rec.OAuth == nil {
		return nil
	}
	s := rec.OAuth
	now := b.d.Now()
	if s.Reconnect {
		return ErrReconnect
	}
	if s.RefreshAt.IsZero() || now.Before(s.RefreshAt) {
		return nil
	}
	expired := !now.Before(s.ExpiresAt)
	if !s.Refreshes {
		if !expired {
			return nil
		}
		b.endSignIn(id, b.epochOf(id), "expired")
		return ErrReconnect
	}
	if b.held(id, now) {
		if expired {
			return ErrUnavailable
		}
		return nil
	}
	err := b.join(ctx, id)
	if errors.Is(err, ErrUnavailable) && !expired {
		return nil
	}
	return err
}

// Renew is for a token its app just refused, whatever its expiry says. A refresh that has only just
// happened counts: the refused request carried the token before it.
func (b *Broker) Renew(ctx context.Context, id string) error {
	rec, ok := b.d.Vault.Record(id)
	if !ok || rec.OAuth == nil {
		return ErrNotSignedIn
	}
	if rec.OAuth.Reconnect {
		return ErrReconnect
	}
	if !rec.OAuth.Refreshes {
		b.endSignIn(id, b.epochOf(id), "refused")
		return ErrReconnect
	}
	now := b.d.Now()
	b.mu.Lock()
	last, seen := b.renewed[id]
	b.mu.Unlock()
	if seen && now.Sub(last) < renewGap {
		return nil
	}
	if b.held(id, now) {
		return ErrUnavailable
	}
	return b.join(ctx, id)
}

// Forget ends the secret's sign-in here and, as far as the app allows, at the app. A refresh in
// flight is told to drop what it gets. Call it before the secret is replaced or removed.
func (b *Broker) Forget(id string) {
	b.commit.Lock()
	defer b.commit.Unlock()
	b.bump(id)
	b.mu.Lock()
	delete(b.holds, id)
	delete(b.renewed, id)
	b.mu.Unlock()
	rec, ok := b.d.Vault.Record(id)
	if !ok || rec.OAuth == nil {
		return
	}
	item, _ := vault.OAuthItem(id)
	st, err := b.load(id)
	if err == nil {
		token, hint := st.RefreshToken, "refresh_token"
		if token == "" {
			if value, err := b.d.Vault.Value(id); err == nil {
				token, hint = string(value), "access_token"
			}
		}
		b.revoke(id, st, token, hint)
	}
	if err := b.d.Store.Delete(item); err != nil && !errors.Is(err, vault.ErrNotFound) {
		log.Printf("keyd: the sign-in of %s stays in the store", id)
	}
}

func (b *Broker) bump(id string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.epochs[id]++
}

func (b *Broker) epochOf(id string) uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.epochs[id]
}

func (b *Broker) held(id string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	until, ok := b.holds[id]
	return ok && now.Before(until)
}

func (b *Broker) load(id string) (state, error) {
	item, binding := vault.OAuthItem(id)
	raw, err := b.d.Store.Get(item, binding)
	if err != nil {
		return state{}, err
	}
	var st state
	if err := json.Unmarshal(raw, &st); err != nil || !validEndpoint(st.TokenEndpoint) {
		return state{}, vault.ErrNotFound
	}
	return st, nil
}

// join waits for the secret's refresh, starting one if none is running. The refresh is the
// broker's, not the request's: one whose caller went away must still keep what it was given, or a
// rotated refresh token would be lost with it.
func (b *Broker) join(ctx context.Context, id string) error {
	b.mu.Lock()
	f := b.flights[id]
	if f == nil {
		f = &flight{done: make(chan struct{})}
		b.flights[id] = f
		epoch := b.epochs[id]
		b.wg.Add(1)
		go func() {
			defer b.wg.Done()
			f.err = b.refresh(id, epoch)
			b.mu.Lock()
			delete(b.flights, id)
			b.mu.Unlock()
			close(f.done)
		}()
	}
	b.mu.Unlock()
	select {
	case <-f.done:
		return f.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (b *Broker) refresh(id string, epoch uint64) error {
	st, err := b.load(id)
	if errors.Is(err, vault.ErrNotFound) || errors.Is(err, vault.ErrReenter) || errors.Is(err, vault.ErrRebound) {
		b.endSignIn(id, epoch, "no refresh token")
		return ErrReconnect
	}
	if errors.Is(err, vault.ErrLocked) {
		return err
	}
	if err != nil {
		return b.failed(id, "the store did not answer")
	}
	if st.RefreshToken == "" {
		b.endSignIn(id, epoch, "no refresh token")
		return ErrReconnect
	}
	ctx, cancel := context.WithTimeout(b.ctx, callTimeout)
	defer cancel()
	reply, err := b.post(ctx, st, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {st.RefreshToken}})
	var refused *RefusedError
	if errors.As(err, &refused) && slices.Contains(finished, refused.Code) {
		b.endSignIn(id, epoch, refused.Code)
		return ErrReconnect
	}
	if err != nil {
		return b.failed(id, "the token endpoint did not refresh")
	}
	b.commit.Lock()
	defer b.commit.Unlock()
	rotated := reply.refresh != "" && reply.refresh != st.RefreshToken
	if b.epochOf(id) != epoch {
		if rotated {
			b.revoke(id, st, reply.refresh, "refresh_token")
		}
		return nil
	}
	rec, ok := b.d.Vault.Record(id)
	if !ok || rec.OAuth == nil {
		return nil
	}
	// The new refresh token is kept first: if keyd dies here the old access token ends soon and this
	// one gets another, while the other way round the sign-in would be lost.
	if rotated {
		st.RefreshToken = reply.refresh
		raw, err := json.Marshal(st)
		if err != nil {
			return b.failed(id, "the refresh token could not be kept")
		}
		item, binding := vault.OAuthItem(id)
		if len(raw) > maxStateBytes || b.d.Store.Put(item, raw, binding) != nil {
			return b.failed(id, "the refresh token could not be kept")
		}
	}
	if err := b.d.Vault.Rotate(id, []byte(reply.access), b.statusOf(reply, true, rec.OAuth.Account)); err != nil {
		return b.failed(id, "the access token could not be kept")
	}
	b.mu.Lock()
	delete(b.holds, id)
	b.renewed[id] = b.d.Now()
	b.mu.Unlock()
	detail := "same refresh token"
	if rotated {
		detail = "refresh token rotated"
	}
	b.note(id, audit.Allow, "oauth-refresh", detail)
	return nil
}

func (b *Broker) failed(id, detail string) error {
	b.mu.Lock()
	b.holds[id] = b.d.Now().Add(retryHold)
	b.mu.Unlock()
	b.note(id, audit.Error, "oauth-refresh", detail)
	return ErrUnavailable
}

// endSignIn records that this sign-in is over. A sign-in made since is not this one.
func (b *Broker) endSignIn(id string, epoch uint64, why string) {
	b.commit.Lock()
	defer b.commit.Unlock()
	if b.epochOf(id) != epoch {
		return
	}
	rec, ok := b.d.Vault.Record(id)
	if !ok || rec.OAuth == nil {
		return
	}
	status := *rec.OAuth
	status.Reconnect = true
	if err := b.d.Vault.SetOAuth(id, &status); err != nil {
		log.Printf("keyd: the end of the sign-in of %s was not recorded", id)
	}
	b.note(id, audit.Deny, "oauth-ended", why)
}

// statusOf is what a token response says about the token. An app that names nobody leaves the
// account as it was.
func (b *Broker) statusOf(reply tokenReply, refreshes bool, account string) *vault.OAuthStatus {
	status := &vault.OAuthStatus{Refreshes: refreshes, Account: account}
	if reply.account != "" {
		status.Account = reply.account
	}
	if reply.lifetime > 0 {
		now := b.d.Now().UTC()
		status.ExpiresAt = now.Add(reply.lifetime)
		status.RefreshAt = status.ExpiresAt.Add(-min(refreshLead, reply.lifetime/4))
	}
	return status
}

func (b *Broker) revoke(id string, st state, token, hint string) {
	if st.RevocationEndpoint == "" || token == "" {
		return
	}
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		ctx, cancel := context.WithTimeout(b.ctx, revokeTimeout)
		defer cancel()
		form := url.Values{"token": {token}, "token_type_hint": {hint}}
		req, err := request(ctx, st, st.RevocationEndpoint, form)
		if err != nil {
			return
		}
		resp, err := b.d.Client.Do(req)
		if err != nil {
			b.note(id, audit.Error, "oauth-revoke", "the app did not answer")
			return
		}
		resp.Body.Close()
		b.note(id, audit.Allow, "oauth-revoke", fmt.Sprintf("status %d", resp.StatusCode))
	}()
}

func (b *Broker) note(id, decision, reason, detail string) {
	if b.d.Audit == nil {
		return
	}
	if _, err := b.d.Audit.Write(audit.Line{Kind: audit.KindAdmin, Decision: decision, Reason: reason, SecretID: id, Detail: detail}); err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
}

func hostOf(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// request makes a POST to endpoint with the client's identity in the way the client registered.
func request(ctx context.Context, st state, endpoint string, form url.Values) (*http.Request, error) {
	basic := st.AuthMethod == "client_secret_basic"
	if !basic {
		form.Set("client_id", st.ClientID)
	}
	if st.AuthMethod == "client_secret_post" {
		form.Set("client_secret", st.ClientSecret)
	}
	if st.Resource != "" {
		form.Set("resource", st.Resource)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "localDot")
	if basic {
		req.SetBasicAuth(url.QueryEscape(st.ClientID), url.QueryEscape(st.ClientSecret))
	}
	return req, nil
}

type tokenReply struct {
	access   string
	refresh  string
	lifetime time.Duration
	account  string
}

// post calls the token endpoint. Its reply stays here: nothing of it is logged or passed on but the
// error code, so a token can't leave by way of an error.
func (b *Broker) post(ctx context.Context, st state, form url.Values) (tokenReply, error) {
	req, err := request(ctx, st, st.TokenEndpoint, form)
	if err != nil {
		return tokenReply{}, ErrUnavailable
	}
	resp, err := b.d.Client.Do(req)
	if err != nil {
		return tokenReply{}, ErrUnavailable
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxReply))
	if err != nil {
		return tokenReply{}, ErrUnavailable
	}
	var fields map[string]json.RawMessage
	parsed := json.Unmarshal(body, &fields) == nil
	if resp.StatusCode == http.StatusBadRequest || resp.StatusCode == http.StatusUnauthorized {
		code := text(fields["error"])
		if !errorCode.MatchString(code) {
			if resp.StatusCode != http.StatusUnauthorized {
				return tokenReply{}, ErrUnavailable
			}
			code = "invalid_client"
		}
		return tokenReply{}, &RefusedError{Code: code}
	}
	if resp.StatusCode != http.StatusOK || !parsed {
		return tokenReply{}, ErrUnavailable
	}
	access := text(fields["access_token"])
	if vault.ValidValue([]byte(access)) != nil {
		return tokenReply{}, ErrUnavailable
	}
	if kind := text(fields["token_type"]); kind != "" && !strings.EqualFold(kind, "bearer") {
		return tokenReply{}, &RefusedError{Code: "unsupported_token_type"}
	}
	reply := tokenReply{access: access, lifetime: lifetimeOf(fields["expires_in"]), account: accountOf(fields)}
	if refresh := text(fields["refresh_token"]); vault.ValidValue([]byte(refresh)) == nil {
		reply.refresh = refresh
	}
	return reply, nil
}

func text(raw json.RawMessage) string {
	var s string
	if raw == nil || json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// lifetimeOf reads expires_in, which some servers send as text. No answer, or nonsense, is unknown.
func lifetimeOf(raw json.RawMessage) time.Duration {
	var seconds float64
	if raw == nil || json.Unmarshal(raw, &seconds) != nil {
		parsed, err := strconv.ParseFloat(text(raw), 64)
		if err != nil {
			return 0
		}
		seconds = parsed
	}
	if seconds < 1 || seconds > 10*365*24*3600 {
		return 0
	}
	return time.Duration(seconds * float64(time.Second))
}

// accountOf is who the reply says signed in. An id token is read for showing only, so its signature
// isn't checked.
func accountOf(fields map[string]json.RawMessage) string {
	for _, name := range []string{"email", "account", "workspace_name", "team_name", "username"} {
		if account := plainAccount(text(fields[name])); account != "" {
			return account
		}
	}
	parts := strings.Split(text(fields["id_token"]), ".")
	if len(parts) != 3 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims map[string]json.RawMessage
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	for _, name := range []string{"email", "preferred_username", "name"} {
		if account := plainAccount(text(claims[name])); account != "" {
			return account
		}
	}
	return ""
}

func plainAccount(raw string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r == unicode.ReplacementChar || unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, raw)
	runes := []rune(strings.TrimSpace(cleaned))
	if len(runes) > maxAccount {
		runes = runes[:maxAccount]
	}
	return string(runes)
}
