package oauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func answering(status int, body any, seen *http.Request) *http.Client {
	return &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		if seen != nil {
			*seen = *r
			raw, _ := io.ReadAll(r.Body)
			seen.Body = io.NopCloser(bytes.NewReader(raw))
		}
		encoded, _ := json.Marshal(body)
		return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(encoded)), Header: http.Header{}, Request: r}, nil
	})}
}

func broker(t *testing.T, client *http.Client) *Broker {
	t.Helper()
	v, err := vault.Open(vault.NewMemory(), "")
	if err != nil {
		t.Fatal(err)
	}
	b := New(Deps{Store: vault.NewMemory(), Vault: v, Client: client})
	t.Cleanup(b.Close)
	return b
}

func grant() Grant {
	return Grant{TokenEndpoint: "https://auth.example.test/token", ClientID: "https://localdot.example.test/client.json",
		Code: "the-code", CodeVerifier: strings.Repeat("v", 43), RedirectURI: "http://127.0.0.1:4750/connectors/callback"}
}

func bindingRecord() vault.Record {
	return vault.Record{ID: "connector-app", Kind: vault.KindHTTP, Hosts: []string{"mcp.example.test"}, Header: "authorization", Format: "bearer"}
}

func connect(b *Broker, g Grant) error {
	return b.Connect(context.Background(), bindingRecord(), g, func(rec vault.Record, value []byte) error {
		return b.d.Vault.Put(rec, value)
	})
}

func TestConnectUsesTheClientsOwnAuthentication(t *testing.T) {
	cases := map[string]struct {
		method string
		check  func(*testing.T, *http.Request, url.Values)
	}{
		"none": {"none", func(t *testing.T, r *http.Request, form url.Values) {
			if form.Get("client_id") == "" || form.Get("client_secret") != "" || r.Header.Get("Authorization") != "" {
				t.Fatalf("%v %v", form, r.Header)
			}
		}},
		"post": {"client_secret_post", func(t *testing.T, r *http.Request, form url.Values) {
			if form.Get("client_secret") != "shh" || r.Header.Get("Authorization") != "" {
				t.Fatalf("%v %v", form, r.Header)
			}
		}},
		"basic": {"client_secret_basic", func(t *testing.T, r *http.Request, form url.Values) {
			user, pass, ok := r.BasicAuth()
			if !ok || user != url.QueryEscape("https://localdot.example.test/client.json") || pass != "shh" || form.Get("client_secret") != "" {
				t.Fatalf("%q %q %v", user, pass, form)
			}
		}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			var seen http.Request
			b := broker(t, answering(200, map[string]any{"access_token": "access-token-1"}, &seen))
			g := grant()
			g.AuthMethod, g.ClientSecret = c.method, "shh"
			if err := connect(b, g); err != nil {
				t.Fatal(err)
			}
			raw, _ := io.ReadAll(seen.Body)
			form, _ := url.ParseQuery(string(raw))
			c.check(t, &seen, form)
		})
	}
}

func TestATokenNotForBearerUseOrWithoutAValueIsRefused(t *testing.T) {
	b := broker(t, answering(200, map[string]any{"access_token": "access-token-1", "token_type": "DPoP"}, nil))
	var refused *RefusedError
	if err := connect(b, grant()); !errors.As(err, &refused) {
		t.Fatalf("%v", err)
	}
	b = broker(t, answering(200, map[string]any{"access_token": "short"}, nil))
	if err := connect(b, grant()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("%v", err)
	}
	if _, ok := b.d.Vault.Record("connector-app"); ok {
		t.Fatal("a bad reply stored a secret")
	}
}

func TestAnUnparseableRefusalIsAPassingFailureUnlessTheClientWasRefused(t *testing.T) {
	b := broker(t, answering(400, "not an oauth error", nil))
	if err := connect(b, grant()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("%v", err)
	}
	b = broker(t, answering(401, "not an oauth error", nil))
	var refused *RefusedError
	if err := connect(b, grant()); !errors.As(err, &refused) || refused.Code != "invalid_client" {
		t.Fatalf("%v", err)
	}
}

func TestLifetimesAreReadOrLeftUnknown(t *testing.T) {
	for raw, want := range map[string]time.Duration{
		`3600`:    time.Hour,
		`"3600"`:  time.Hour,
		`0`:       0,
		`-1`:      0,
		`"soon"`:  0,
		`1e12`:    0,
		`{"a":1}`: 0,
	} {
		if got := lifetimeOf(json.RawMessage(raw)); got != want {
			t.Errorf("%s: %v", raw, got)
		}
	}
	if lifetimeOf(nil) != 0 {
		t.Error("no lifetime is unknown")
	}
}

func idToken(claims map[string]any) string {
	body, _ := json.Marshal(claims)
	return "e30." + base64.RawURLEncoding.EncodeToString(body) + ".sig"
}

func TestWhoSignedInIsReadForShowingOnly(t *testing.T) {
	raw := func(v any) json.RawMessage {
		encoded, _ := json.Marshal(v)
		return encoded
	}
	for _, c := range []struct {
		fields map[string]json.RawMessage
		want   string
	}{
		{map[string]json.RawMessage{"email": raw("ada@example.test")}, "ada@example.test"},
		{map[string]json.RawMessage{"id_token": raw(idToken(map[string]any{"email": "ada@id.example.test", "name": "Ada"}))}, "ada@id.example.test"},
		{map[string]json.RawMessage{"id_token": raw(idToken(map[string]any{"name": "Ada"}))}, "Ada"},
		{map[string]json.RawMessage{"id_token": raw("not.a-token")}, ""},
		{map[string]json.RawMessage{"email": raw("ada\x00‮@example.test\n")}, "ada@example.test"},
		{map[string]json.RawMessage{"email": raw(strings.Repeat("a", 500))}, strings.Repeat("a", maxAccount)},
		{map[string]json.RawMessage{}, ""},
	} {
		if got := accountOf(c.fields); got != c.want {
			t.Errorf("%v: %q", c.fields, got)
		}
	}
}

func TestARefreshTokenTooLargeToKeepConnectsWithoutOne(t *testing.T) {
	b := broker(t, answering(200, map[string]any{"access_token": "access-token-1", "refresh_token": strings.Repeat("r", 8000), "expires_in": 3600}, nil))
	g := grant()
	g.ClientSecret = strings.Repeat("s", 500)
	g.AuthMethod = "client_secret_post"
	if err := connect(b, g); err != nil {
		t.Fatal(err)
	}
	rec, _ := b.d.Vault.Record("connector-app")
	if rec.OAuth == nil || rec.OAuth.Refreshes {
		t.Fatalf("%+v", rec.OAuth)
	}
}

func TestAStoreThatCannotKeepTheSignInLeavesNothingBehind(t *testing.T) {
	b := broker(t, answering(200, map[string]any{"access_token": "access-token-1", "refresh_token": "refresh-token-1"}, nil))
	boom := errors.New("the vault said no")
	err := b.Connect(context.Background(), bindingRecord(), grant(), func(vault.Record, []byte) error { return boom })
	if !errors.Is(err, boom) {
		t.Fatalf("%v", err)
	}
	item, binding := vault.OAuthItem("connector-app")
	if _, err := b.d.Store.Get(item, binding); !errors.Is(err, vault.ErrNotFound) {
		t.Fatalf("%v", err)
	}
}

func TestForgetAndRenewLeaveOtherSecretsAlone(t *testing.T) {
	b := broker(t, answering(500, nil, nil))
	if err := b.d.Vault.Put(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "authorization", Format: "bearer"}, []byte("a-saved-api-key")); err != nil {
		t.Fatal(err)
	}
	b.Forget("weather")
	if err := b.Fresh(context.Background(), "weather"); err != nil {
		t.Fatal(err)
	}
	if err := b.Renew(context.Background(), "weather"); !errors.Is(err, ErrNotSignedIn) {
		t.Fatal(err)
	}
	if value, err := b.d.Vault.Value("weather"); err != nil || string(value) != "a-saved-api-key" {
		t.Fatalf("%q %v", value, err)
	}
}
