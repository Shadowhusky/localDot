package keys

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func binding(t *testing.T, rec vault.Record) Binding {
	t.Helper()
	b, err := FromRecord(rec)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mint(t *testing.T, r *Registry, cell string, b Binding) string {
	t.Helper()
	e, err := r.Mint(cell, b)
	if err != nil {
		t.Fatal(err)
	}
	return e.Token
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

type req struct {
	dest   Dest
	method string
	url    string
	header http.Header
}

func (q req) inspect(r *Registry) Verdict {
	u, _ := url.Parse(q.url)
	method := q.method
	if method == "" {
		method = "GET"
	}
	return r.Inspect(q.dest, method, u, q.header)
}

// Includes the cases of sandbox-runtime's credential-mask tests (per-host gating, anti-laundering,
// arbitrary header names, mixed surrogates); where srt passes a sentinel through, keyd refuses.
func TestInspect(t *testing.T) {
	r := NewRegistry()
	bearer := binding(t, vault.Record{ID: "api", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"})
	rawB := binding(t, vault.Record{ID: "dd-api", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Dd-Api-Key", Format: "raw"})
	rawC := binding(t, vault.Record{ID: "dd-app", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Dd-Application-Key", Format: "raw"})
	pass := binding(t, vault.Record{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"git.example.test"}, Header: "Authorization", Format: "basic-password"})
	user := binding(t, vault.Record{ID: "pay", Kind: vault.KindHTTP, Hosts: []string{"pay.example.test"}, Header: "Authorization", Format: "basic-user"})
	limited := binding(t, vault.Record{ID: "ro", Kind: vault.KindHTTP, Hosts: []string{"ro.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{"/v1/"}})
	prefixed := binding(t, vault.Record{ID: "pre", Kind: vault.KindHTTP, Hosts: []string{"pre.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1"}})
	llm := binding(t, vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"})

	tok := mint(t, r, "c1", bearer)
	tokB := mint(t, r, "c1", rawB)
	tokC := mint(t, r, "c1", rawC)
	tokPass := mint(t, r, "c1", pass)
	tokUser := mint(t, r, "c1", user)
	tokRO := mint(t, r, "c1", limited)
	tokPre := mint(t, r, "c1", prefixed)
	tokLLM := mint(t, r, "c1", llm)
	foreign := mint(t, r, "c2", bearer)
	revoked := mint(t, r, "c3", bearer)
	r.RevokeCell("c3")
	unknown, _ := surrogate.Mint("key")
	forged := "ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA"

	https := func(host string) Dest { return Dest{Cell: "c1", Scheme: "https", Host: host} }
	gateway := func(route string) Dest { return Dest{Cell: "c1", Scheme: "gateway", Route: route} }
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i < len(kv); i += 2 {
			out.Add(kv[i], kv[i+1])
		}
		return out
	}
	// ro is a GET to ro.example.test, whose secret is limited to GET and /v1/, with its surrogate.
	ro := func(rawURL string, kv ...string) req {
		return req{dest: https("ro.example.test"), url: rawURL, header: h(append([]string{"Authorization", "Bearer " + tokRO}, kv...)...)}
	}

	cases := []struct {
		name   string
		q      req
		reason string
		swaps  int
	}{
		{"bearer on its host", req{dest: https("api.example.test"), url: "/v1/x", header: h("Authorization", "Bearer "+tok)}, "", 1},
		{"bearer scheme in any case", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "bearer "+tok)}, "", 1},
		{"no surrogate at all", req{dest: https("api.example.test"), url: "/", header: h("Accept", "*/*")}, "", 0},
		{"two surrogates, two headers", req{dest: https("api.example.test"), url: "/", header: h("Dd-Api-Key", tokB, "Dd-Application-Key", tokC)}, "", 2},
		{"mixed: one surrogate bound elsewhere", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+tok, "X-Git", tokPass)}, ReasonMisplacedSurrogate, 0},
		{"basic password", req{dest: https("git.example.test"), url: "/", header: h("Authorization", basic("x-access-token", tokPass))}, "", 1},
		{"basic user", req{dest: https("pay.example.test"), url: "/", header: h("Authorization", basic(tokUser, ""))}, "", 1},
		{"gateway route", req{dest: gateway("anthropic"), method: "POST", url: "/anthropic/messages", header: h("X-Api-Key", tokLLM)}, "", 1},
		{"unknown surrogate", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+unknown)}, ReasonUnknownSurrogate, 0},
		{"forged checksum", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+forged)}, ReasonUnknownSurrogate, 0},
		{"revoked surrogate", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+revoked)}, ReasonUnknownSurrogate, 0},
		{"another cell's surrogate", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+foreign)}, ReasonMisplacedSurrogate, 0},
		{"wrong host", req{dest: https("other.example.test"), url: "/", header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"plain http to the bound host", req{dest: Dest{Cell: "c1", Scheme: "http", Host: "api.example.test"}, url: "/", header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"wrong header", req{dest: https("api.example.test"), url: "/", header: h("X-Api-Key", tok)}, ReasonMisplacedSurrogate, 0},
		{"substring of the header", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+tok+" extra")}, ReasonMisplacedSurrogate, 0},
		{"double space", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer  "+tok)}, ReasonMisplacedSurrogate, 0},
		{"other scheme", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Token "+tok)}, ReasonMisplacedSurrogate, 0},
		{"two header values", req{dest: https("api.example.test"), url: "/", header: h("Authorization", "Bearer "+tok, "Authorization", "Bearer x")}, ReasonMisplacedSurrogate, 0},
		{"in the query", req{dest: https("api.example.test"), url: "/?key=" + tok}, ReasonMisplacedSurrogate, 0},
		{"percent-encoded in the query", req{dest: https("api.example.test"), url: "/?key=ld%5F" + tok[3:]}, ReasonMisplacedSurrogate, 0},
		{"in the path", req{dest: https("api.example.test"), url: "/keys/" + tok}, ReasonMisplacedSurrogate, 0},
		{"header and query", req{dest: https("api.example.test"), url: "/?k=" + tok, header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"basic with the surrogate twice", req{dest: https("git.example.test"), url: "/", header: h("Authorization", basic(tokPass, tokPass))}, ReasonMisplacedSurrogate, 0},
		{"llm surrogate to another route", req{dest: gateway("openai"), method: "POST", url: "/openai/responses", header: h("X-Api-Key", tokLLM)}, ReasonMisplacedSurrogate, 0},
		{"llm surrogate over https", req{dest: https("api.anthropic.com"), url: "/", header: h("X-Api-Key", tokLLM)}, ReasonMisplacedSurrogate, 0},
		{"http surrogate on the gateway", req{dest: gateway("anthropic"), method: "POST", url: "/anthropic/messages", header: h("Authorization", "Bearer "+tok)}, ReasonMisplacedSurrogate, 0},
		{"method outside the binding", req{dest: https("ro.example.test"), method: "POST", url: "/v1/x", header: h("Authorization", "Bearer "+tokRO)}, ReasonSurrogatePolicy, 0},
		{"path outside the binding", req{dest: https("ro.example.test"), url: "/admin", header: h("Authorization", "Bearer "+tokRO)}, ReasonSurrogatePolicy, 0},
		{"a limited path with a trailing slash", ro("/v1/forecast/"), "", 1},
		{"dot segments", ro("/v1/../admin"), ReasonSurrogatePolicy, 0},
		{"encoded dot segments", ro("/v1/%2e%2e/admin"), ReasonSurrogatePolicy, 0},
		{"encoded dot segments in capitals", ro("/v1/%2E%2E/admin"), ReasonSurrogatePolicy, 0},
		{"encoded slashes", ro("/v1%2f..%2fadmin"), ReasonSurrogatePolicy, 0},
		{"an encoded slash in a clean path", ro("/v1%2Fadmin"), ReasonSurrogatePolicy, 0},
		{"double-encoded dots", ro("/v1/%252e%252e/admin"), ReasonSurrogatePolicy, 0},
		{"encoded backslashes", ro("/v1/%5c..%5cadmin"), ReasonSurrogatePolicy, 0},
		{"backslashes", ro(`/v1/x\..\..\admin`), ReasonSurrogatePolicy, 0},
		{"a NUL", ro("/v1/x%00/../admin"), ReasonSurrogatePolicy, 0},
		{"doubled slashes", ro("/v1//admin"), ReasonSurrogatePolicy, 0},
		{"a ; parameter hiding dot segments", ro("/v1/..;/admin"), ReasonSurrogatePolicy, 0},
		{"a ; parameter", ro("/v1;x=1/forecast"), ReasonSurrogatePolicy, 0},
		{"the method in lower case", req{dest: https("ro.example.test"), method: "get", url: "/v1/x", header: h("Authorization", "Bearer "+tokRO)}, ReasonSurrogatePolicy, 0},
		{"a method override header", ro("/v1/x", "X-HTTP-Method-Override", "DELETE"), ReasonSurrogatePolicy, 0},
		{"a _method parameter", ro("/v1/x?_method=DELETE"), ReasonSurrogatePolicy, 0},
		{"an encoded _method parameter", ro("/v1/x?a=1&%5Fmethod=DELETE"), ReasonSurrogatePolicy, 0},
		{"a prefix permits its own path", req{dest: https("pre.example.test"), url: "/v1", header: h("Authorization", "Bearer "+tokPre)}, "", 1},
		{"a prefix ends at a segment", req{dest: https("pre.example.test"), url: "/v1-admin", header: h("Authorization", "Bearer "+tokPre)}, ReasonSurrogatePolicy, 0},
		{"in the host name", req{dest: https("api.example.test"), url: "https://" + unknown + ".example.test/"}, ReasonUnknownSurrogate, 0},
		{"percent-encoded after a bad escape", req{dest: https("api.example.test"), url: "/?a=%zz&k=ld%5F" + tok[3:]}, ReasonMisplacedSurrogate, 0},
	}
	for _, c := range cases {
		v := c.q.inspect(r)
		if c.reason == "" {
			if !v.Allow || len(v.Swaps) != c.swaps {
				t.Errorf("%s: %+v, want allow with %d swaps", c.name, v, c.swaps)
			}
			continue
		}
		if v.Allow || v.Reason != c.reason || v.SurrogateID == "" {
			t.Errorf("%s: %+v, want deny %s with a surrogate id", c.name, v, c.reason)
		}
	}
}

func TestApplySwaps(t *testing.T) {
	r := NewRegistry()
	values := map[string]string{"api": "real-bearer-value", "dd-api": "real-raw-value", "git": "real-password-value", "pay": "real-user-value"}
	value := func(id string) ([]byte, error) { return []byte(values[id]), nil }
	recs := []vault.Record{
		{ID: "api", Kind: vault.KindHTTP, Hosts: []string{"a.example.test"}, Header: "Authorization", Format: "bearer"},
		{ID: "dd-api", Kind: vault.KindHTTP, Hosts: []string{"a.example.test"}, Header: "Dd-Api-Key", Format: "raw"},
		{ID: "git", Kind: vault.KindHTTP, Hosts: []string{"g.example.test"}, Header: "Authorization", Format: "basic-password"},
		{ID: "pay", Kind: vault.KindHTTP, Hosts: []string{"p.example.test"}, Header: "Authorization", Format: "basic-user"},
	}
	var toks []string
	for _, rec := range recs {
		toks = append(toks, mint(t, r, "c1", binding(t, rec)))
	}
	cases := []struct {
		host, header, value, want string
	}{
		{"a.example.test", "Authorization", "Bearer " + toks[0], "Bearer real-bearer-value"},
		{"a.example.test", "Dd-Api-Key", toks[1], "real-raw-value"},
		{"g.example.test", "Authorization", basic("bot", toks[2]), basic("bot", "real-password-value")},
		{"p.example.test", "Authorization", basic(toks[3], ""), basic("real-user-value", "")},
	}
	for _, c := range cases {
		h := http.Header{c.header: {c.value}}
		u, _ := url.Parse("/")
		v := r.Inspect(Dest{Cell: "c1", Scheme: "https", Host: c.host}, "GET", u, h)
		if !v.Allow {
			t.Fatalf("%s: %+v", c.header, v)
		}
		if err := ApplySwaps(h, v.Swaps, value); err != nil {
			t.Fatal(err)
		}
		if got := h.Get(c.header); got != c.want {
			t.Errorf("%s: %q, want %q", c.host, got, c.want)
		}
	}
	boom := errors.New("keychain locked")
	h := http.Header{"Authorization": {"Bearer " + toks[0]}}
	u, _ := url.Parse("/")
	v := r.Inspect(Dest{Cell: "c1", Scheme: "https", Host: "a.example.test"}, "GET", u, h)
	if err := ApplySwaps(h, v.Swaps, func(string) ([]byte, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}

func TestRegistry(t *testing.T) {
	r := NewRegistry()
	b := binding(t, vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"})
	e, err := r.Mint("c1", b)
	if err != nil {
		t.Fatal(err)
	}
	if !surrogate.Valid(e.Token) || e.ID != surrogate.ID(e.Token) || e.Cell != "c1" {
		t.Fatalf("entry %+v", e)
	}
	if got, ok := r.Lookup(e.Token); !ok || got.Binding.SecretID != "anthropic" {
		t.Fatalf("Lookup = %+v, %v", got, ok)
	}
	if n := len(r.ForCell("c1")); n != 1 {
		t.Fatalf("ForCell = %d", n)
	}
	if n := r.RevokeCell("c1"); n != 1 {
		t.Fatalf("RevokeCell = %d", n)
	}
	if _, ok := r.Lookup(e.Token); ok {
		t.Fatal("revoked token still resolves")
	}
	a, _ := r.Mint("c1", b)
	other, _ := r.Mint("c2", b)
	weather := binding(t, vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"})
	keep, _ := r.Mint("c1", weather)
	if n := r.RevokeSecret("anthropic"); n != 2 {
		t.Fatalf("RevokeSecret = %d, want 2", n)
	}
	for _, tok := range []string{a.Token, other.Token} {
		if _, ok := r.Lookup(tok); ok {
			t.Fatal("a surrogate of the revoked secret still resolves")
		}
	}
	if _, ok := r.Lookup(keep.Token); !ok {
		t.Fatal("RevokeSecret dropped another secret's surrogate")
	}
}
