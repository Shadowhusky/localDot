package admin

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/oauth"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	oauthID      = "connector-app"
	codeVerifier = "verifier-0123456789-0123456789-0123456789-0123"
)

// tokenService stands in for an app's sign-in service behind keyd's HTTP client.
type tokenService struct {
	mu    sync.Mutex
	forms []url.Values
	reply func(url.Values) (int, map[string]any)
	now   time.Time
}

func (s *tokenService) clock() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.now
}

func (s *tokenService) advance(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.now = s.now.Add(d)
}

func (s *tokenService) RoundTrip(r *http.Request) (*http.Response, error) {
	raw, _ := io.ReadAll(r.Body)
	form, _ := url.ParseQuery(string(raw))
	s.mu.Lock()
	defer s.mu.Unlock()
	s.forms = append(s.forms, form)
	status, body := s.reply(form)
	encoded, _ := json.Marshal(body)
	return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(encoded)), Header: http.Header{}, Request: r}, nil
}

func oauthFixture(t *testing.T, reply func(url.Values) (int, map[string]any)) (*fixture, *tokenService) {
	t.Helper()
	service := &tokenService{reply: reply, now: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
	var tokens *oauth.Broker
	f := newFixtureWithDeps(t, func(deps *egress.Deps) {
		store := vault.NewMemory()
		v, _ := vault.Open(store, "")
		deps.Vault = v
		tokens = oauth.New(oauth.Deps{Store: store, Vault: v, Client: &http.Client{Transport: service}, Now: service.clock})
		deps.Tokens = tokens
	})
	f.s.Tokens = tokens
	t.Cleanup(tokens.Close)
	return f, service
}

func grantBody() map[string]any {
	return map[string]any{
		"hosts": []string{"mcp.app.example.test"}, "header": "authorization", "format": "bearer",
		"tokenEndpoint": "https://auth.app.example.test/token", "clientId": "https://localdot.example.test/client.json",
		"resource": "https://mcp.app.example.test/mcp", "code": "the-code", "codeVerifier": codeVerifier,
		"redirectUri": "http://127.0.0.1:4750/connectors/callback",
	}
}

func issued(form url.Values) (int, map[string]any) {
	return 200, map[string]any{"access_token": "access-token-1", "refresh_token": "refresh-token-1", "token_type": "bearer", "expires_in": 3600, "email": "ada@example.test"}
}

func TestStatusSaysThisKeydRedeemsSignIns(t *testing.T) {
	f, _ := oauthFixture(t, issued)
	if _, body := f.call(t, "GET", "/v1/status", nil); body["oauth"] != true {
		t.Fatalf("%v", body)
	}
	plain := newFixture(t)
	if _, body := plain.call(t, "GET", "/v1/status", nil); body["oauth"] != false {
		t.Fatalf("%v", body)
	}
	if code, _ := plain.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", grantBody()); code != http.StatusServiceUnavailable {
		t.Fatalf("%d", code)
	}
}

func TestConnectRedeemsTheCodeAndTellsTheDaemonNoToken(t *testing.T) {
	f, service := oauthFixture(t, issued)
	code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", grantBody())
	if code != 200 {
		t.Fatalf("%d %v", code, body)
	}
	raw, _ := json.Marshal(body)
	if strings.Contains(string(raw), "access-token") || strings.Contains(string(raw), "refresh-token") {
		t.Fatalf("the reply holds a token: %s", raw)
	}
	state, _ := body["oauth"].(map[string]any)
	if state["refreshes"] != true || state["account"] != "ada@example.test" || state["expiresAt"] == nil {
		t.Fatalf("%v", body)
	}
	form := service.forms[0]
	if form.Get("grant_type") != "authorization_code" || form.Get("code_verifier") != codeVerifier || form.Get("resource") != "https://mcp.app.example.test/mcp" {
		t.Fatalf("%v", form)
	}
	code, listed := f.call(t, "GET", "/v1/secrets", nil)
	raw, _ = json.Marshal(listed)
	if code != 200 || !strings.Contains(string(raw), `"account":"ada@example.test"`) || strings.Contains(string(raw), "-token-1") {
		t.Fatalf("%d %s", code, raw)
	}
}

func TestConnectRefusesWhatCouldSendATokenSomewhereElse(t *testing.T) {
	cases := map[string]func(map[string]any){
		"plain http token endpoint": func(b map[string]any) { b["tokenEndpoint"] = "http://auth.app.example.test/token" },
		"loopback token endpoint":   func(b map[string]any) { b["tokenEndpoint"] = "https://127.0.0.1/token" },
		"local name":                func(b map[string]any) { b["tokenEndpoint"] = "https://localhost/token" },
		"another port":              func(b map[string]any) { b["tokenEndpoint"] = "https://auth.app.example.test:8443/token" },
		"credentials in the URL":    func(b map[string]any) { b["tokenEndpoint"] = "https://user:pass@auth.app.example.test/token" },
		"revocation elsewhere":      func(b map[string]any) { b["revocationEndpoint"] = "http://auth.app.example.test/revoke" },
		"no verifier":               func(b map[string]any) { b["codeVerifier"] = "" },
		"plain http redirect":       func(b map[string]any) { b["redirectUri"] = "http://evil.example.test/cb" },
		"a binding it can't have":   func(b map[string]any) { b["header"] = "Host" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f, service := oauthFixture(t, issued)
			body := grantBody()
			change(body)
			if code, reply := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", body); code != http.StatusBadRequest {
				t.Fatalf("%d %v", code, reply)
			}
			if len(service.forms) != 0 {
				t.Fatal("the token endpoint was called")
			}
			if _, ok := f.s.Vault.Record(oauthID); ok {
				t.Fatal("a secret was stored")
			}
		})
	}
}

func TestConnectNamesARefusalWithoutRepeatingTheApp(t *testing.T) {
	f, _ := oauthFixture(t, func(url.Values) (int, map[string]any) {
		return 400, map[string]any{"error": "invalid_grant", "error_description": "code-echo the-code"}
	})
	code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", grantBody())
	raw, _ := json.Marshal(body)
	if code != http.StatusBadGateway || !strings.Contains(string(raw), "oauth-refused") || !strings.Contains(string(raw), "invalid_grant") || strings.Contains(string(raw), "the-code") {
		t.Fatalf("%d %s", code, raw)
	}
	if _, ok := f.s.Vault.Record(oauthID); ok {
		t.Fatal("a refused sign-in stored a secret")
	}
}

func TestRenewSaysWhereTheSignInStands(t *testing.T) {
	refused := false
	f, service := oauthFixture(t, func(form url.Values) (int, map[string]any) {
		if refused {
			return 400, map[string]any{"error": "invalid_grant"}
		}
		return issued(form)
	})
	if code, _ := f.call(t, "POST", "/v1/secrets/none/oauth/refresh", map[string]any{}); code != http.StatusNotFound {
		t.Fatalf("%d", code)
	}
	if code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", grantBody()); code != 200 {
		t.Fatalf("%d %v", code, body)
	}
	// Just connected: the refused request carried an older token, so nothing is refreshed.
	if code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth/refresh", map[string]any{}); code != 200 || body["state"] != "fresh" {
		t.Fatalf("%d %v", code, body)
	}
	if len(service.forms) != 1 {
		t.Fatalf("%d calls", len(service.forms))
	}
	// Later, a refused token is refreshed.
	service.advance(time.Minute)
	if code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth/refresh", map[string]any{}); code != 200 || body["state"] != "fresh" {
		t.Fatalf("%d %v", code, body)
	}
	if len(service.forms) != 2 || service.forms[1].Get("refresh_token") != "refresh-token-1" {
		t.Fatalf("%v", service.forms)
	}
	// And an app that has ended the sign-in says so, to the daemon and in the list.
	refused = true
	service.advance(time.Minute)
	if code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth/refresh", map[string]any{}); code != 200 || body["state"] != "reconnect" {
		t.Fatalf("%d %v", code, body)
	}
	if rec, _ := f.s.Vault.Record(oauthID); rec.OAuth == nil || !rec.OAuth.Reconnect {
		t.Fatalf("%+v", rec.OAuth)
	}
}

func TestKeyCopyLeavesTheSignInBehind(t *testing.T) {
	f, _ := oauthFixture(t, issued)
	if code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", grantBody()); code != 200 {
		t.Fatalf("%d %v", code, body)
	}
	rec, _ := f.s.Vault.Record(oauthID)
	// What a copy sends is this body; a refresh token shared by two keyds would rotate one out.
	raw, _ := json.Marshal(putSecretBody{Kind: rec.Kind, Hosts: rec.Hosts, Header: rec.Header, Format: rec.Format})
	if strings.Contains(string(raw), "oauth") || strings.Contains(string(raw), "refresh") {
		t.Fatalf("%s", raw)
	}
	item, _ := vault.OAuthItem(oauthID)
	for _, listed := range f.s.Vault.Records() {
		if listed.ID == item {
			t.Fatal("the refresh state is listed as a key")
		}
	}
}

func TestReplacingARecordWithAKeyEndsItsSignIn(t *testing.T) {
	f, _ := oauthFixture(t, issued)
	if code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", grantBody()); code != 200 {
		t.Fatalf("%d %v", code, body)
	}
	fields := map[string]any{"kind": "http", "hosts": []string{"mcp.app.example.test"}, "header": "authorization", "format": "bearer"}
	if code, body := f.sealedPut(t, oauthID, fields, fakeKey); code != 200 {
		t.Fatalf("%d %v", code, body)
	}
	rec, _ := f.s.Vault.Record(oauthID)
	if rec.OAuth != nil {
		t.Fatalf("%+v", rec.OAuth)
	}
	if err := f.s.Tokens.Renew(context.Background(), oauthID); err != oauth.ErrNotSignedIn {
		t.Fatalf("%v", err)
	}
}

func TestDeletingASecretEndsItsSignInEverywhere(t *testing.T) {
	f, _ := oauthFixture(t, issued)
	if code, body := f.call(t, "POST", "/v1/secrets/"+oauthID+"/oauth", grantBody()); code != 200 {
		t.Fatalf("%d %v", code, body)
	}
	if code, _ := f.call(t, "DELETE", "/v1/secrets/"+oauthID, nil); code != http.StatusNoContent {
		t.Fatalf("%d", code)
	}
	if err := f.s.Tokens.Renew(context.Background(), oauthID); err != oauth.ErrNotSignedIn {
		t.Fatalf("%v", err)
	}
}

func TestAKeyCannotTakeTheNameOfASignInsStoreItem(t *testing.T) {
	f, _ := oauthFixture(t, issued)
	item, _ := vault.OAuthItem(oauthID)
	fields := map[string]any{"kind": "http", "hosts": []string{"mcp.app.example.test"}, "header": "authorization", "format": "bearer"}
	if code, body := f.sealedPut(t, item, fields, fakeKey); code != http.StatusBadRequest {
		t.Fatalf("%d %v", code, body)
	}
}
