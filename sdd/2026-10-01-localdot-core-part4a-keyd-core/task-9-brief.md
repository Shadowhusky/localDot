### Task 9: The surrogate registry — bindings, inspection and the header swap

This is the authd half of Muse's split: what each secret is bound to, the surrogates minted for each
cell, and the rule that decides whether a request may carry them. A binding comes from the vault
record the user's key form wrote, never from the cell: an HTTP secret names its exact hosts (https
on 443), one header and a format (`bearer`, `raw`, `basic-user`, `basic-password`), optionally
methods and path prefixes; an LLM secret names a provider, and the preset gives the base URL, the
auth header and the operations (P4a-R14). Each operation also says what the gateway's budget needs
(P4a-R27): the API its JSON follows, which says where it carries images, and the field the provider
reads its output cap from (`max_tokens` for Anthropic's messages and OpenAI-compatible servers' chat
completions, `max_completion_tokens` for OpenAI's and Azure's, `max_output_tokens` for Responses,
`generationConfig.maxOutputTokens` for Gemini), or none for embeddings and token counts, which are
free. Inspection finds every surrogate-shaped token in the
request line and the headers — Basic credentials decoded — and refuses the request unless each one
is this cell's, bound to this destination, appears exactly once and sits exactly in its bound header
in its bound format (spec, "Swap rules"; S4: iron-proxy passed unknown and misplaced surrogates
through). The URL's host is part of the request line, and a query with one invalid escape is still
decoded escape by escape, so neither hides a surrogate (review 1, M2 and M10). A binding's method
and path limits hold only on a path every server reads the same way: for a path-limited binding
the decoded path must be clean (one trailing slash allowed), printable ASCII and free of `;` and
backslashes, the raw path must hold no encoded dot, slash, backslash, percent sign or NUL in any
case, and a prefix ends at a segment (`/v1/` permits only what lies under it, not `/v1`; review 2,
N3); a method-limited binding also refuses the override headers and a `_method` query parameter (a
`_method` in a form body, which Rails, Laravel and Spring also read, is not seen: P4a-R8). Anything
else is refused as `surrogate-policy`, since real servers read `/v1/../admin`, `/v1/%2e%2e/admin` and
`/v1%2f..%2fadmin` as `/admin` (review 1, C2). Only then does
`ApplySwaps` put the real values in, Basic auth re-encoded. The cases of sandbox-runtime's
credential-mask tests are ported into `TestInspect`; where srt passes a sentinel through unchanged,
keyd refuses (P4a-R8).

**Files:**
- Create: `keyd/internal/keys/binding.go`, `keyd/internal/keys/registry.go`, `keyd/internal/keys/inspect.go`
- Test: `keyd/internal/keys/binding_test.go`, `keyd/internal/keys/inspect_test.go`

**Interfaces:**
- Consumes: `surrogate.Mint`, `surrogate.Find`, `surrogate.ID` (Task 1); `vault.Record`,
  `vault.ValidValue`, `vault.KindLLM`, `vault.KindHTTP` (Task 2); `policy.ValidBindingHost` (Task 8).
- Produces: `Format` (`Bearer`, `Raw`, `BasicUser`, `BasicPassword`); `Op{Method string; Path *regexp.Regexp; Model bool; Body, Cap string; Free bool}`
  (`Body` is `anthropic`, `chat`, `completions`, `responses`, `embeddings` or `gemini`; `Cap` a
  top-level field or `generationConfig.maxOutputTokens`)
  with `ModelFrom(path) string`; `Binding{SecretID, Tag string; Hosts []string; Route string; Upstream *url.URL; Local bool; Ops []Op; Header string; Format Format; Methods, Paths []string}`
  with `Op(method, path) (Op, bool)` and `Permits(method, path) bool` (on a decoded, clean path; a
  prefix ends at a segment, and one ending in `/` permits only what lies under it);
  `FromRecord(vault.Record) (Binding, error)` (path prefixes clean,
  absolute, printable ASCII, without `;`, backslash or `%`);
  `LocalRoutes() map[string]Binding` (`lmstudio` → `http://127.0.0.1:1234/v1`, `ollama` →
  `http://127.0.0.1:11434/v1`); `ValidValueFor(Binding, []byte) error`;
  `Entry{Token, ID, Cell string; Binding Binding}`; `NewRegistry() *Registry`, `Mint(cell, Binding) (Entry, error)`,
  `Lookup(token) (Entry, bool)`, `ForCell(cell) []Entry`, `RevokeCell(cell) int`, `RevokeSecret(secretID) int`;
  reasons `ReasonUnknownSurrogate`, `ReasonMisplacedSurrogate`, `ReasonSurrogatePolicy`;
  `Dest{Cell, Scheme, Host, Route string}` (Scheme `https` for an intercepted host, `http` for a
  plain request, `gateway` for an LLM route, `connect` for the CONNECT line);
  `Verdict{Allow bool; Reason string; Swaps []Entry; SecretID, SurrogateID string}`;
  `(*Registry).Inspect(d Dest, method string, u *url.URL, h http.Header) Verdict`;
  `ApplySwaps(h http.Header, swaps []Entry, value func(secretID string) ([]byte, error)) error`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/keys/binding_test.go`:
```go
package keys

import (
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func TestLLMPresets(t *testing.T) {
	b, err := FromRecord(vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"})
	if err != nil {
		t.Fatal(err)
	}
	if b.Route != "anthropic" || b.Upstream.String() != "https://api.anthropic.com/v1" || b.Header != "X-Api-Key" || b.Format != Raw || b.Tag != "ant" {
		t.Fatalf("anthropic binding %+v", b)
	}
	if op, ok := b.Op("POST", "messages"); !ok || op.Model {
		t.Fatalf("POST messages: %+v %v", op, ok)
	}
	if _, ok := b.Op("POST", "files"); ok {
		t.Fatal("POST files is allowed")
	}
	g, err := FromRecord(vault.Record{ID: "gemini", Kind: vault.KindLLM, Provider: "google"})
	if err != nil {
		t.Fatal(err)
	}
	op, ok := g.Op("POST", "models/gemini-3.6-flash:streamGenerateContent")
	if !ok || !op.Model || op.ModelFrom("models/gemini-3.6-flash:streamGenerateContent") != "gemini-3.6-flash" {
		t.Fatalf("gemini op %+v %v", op, ok)
	}
	c, err := FromRecord(vault.Record{ID: "groq", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://api.groq.com/openai/v1/"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Upstream.String() != "https://api.groq.com/openai/v1" || c.Header != "Authorization" || c.Format != Bearer {
		t.Fatalf("openai-compatible binding %+v", c)
	}
}

func TestEachOperationNamesItsOutputCap(t *testing.T) {
	cases := []struct {
		provider, baseURL, method, path string
		body, cap                       string
		free                            bool
	}{
		{"anthropic", "", "POST", "messages", "anthropic", "max_tokens", false},
		{"anthropic", "", "POST", "messages/count_tokens", "anthropic", "", true},
		{"openai", "", "POST", "chat/completions", "chat", "max_completion_tokens", false},
		{"openai", "", "POST", "completions", "completions", "max_tokens", false},
		{"openai", "", "POST", "responses", "responses", "max_output_tokens", false},
		{"openai", "", "POST", "embeddings", "embeddings", "", false},
		{"azure", "https://res.openai.azure.com/openai/v1", "POST", "chat/completions", "chat", "max_completion_tokens", false},
		{"openai-compatible", "https://llm.example.test/v1", "POST", "chat/completions", "chat", "max_tokens", false},
		{"openai-compatible", "https://llm.example.test/v1", "POST", "responses", "responses", "max_output_tokens", false},
		{"google", "", "POST", "models/gemini-3.6-flash:streamGenerateContent", "gemini", "generationConfig.maxOutputTokens", false},
		{"google", "", "POST", "models/gemini-3.6-flash:generateContent", "gemini", "generationConfig.maxOutputTokens", false},
		{"google", "", "POST", "models/gemini-3.6-flash:countTokens", "gemini", "", true},
		{"google", "", "POST", "models/gemini-embedding-2:batchEmbedContents", "embeddings", "", false},
		{"google", "", "GET", "models", "", "", false},
	}
	for _, c := range cases {
		b, err := FromRecord(vault.Record{ID: "r", Kind: vault.KindLLM, Provider: c.provider, BaseURL: c.baseURL})
		if err != nil {
			t.Fatal(err)
		}
		op, ok := b.Op(c.method, c.path)
		if !ok || op.Body != c.body || op.Cap != c.cap || op.Free != c.free {
			t.Errorf("%s %s %s: %+v %v", c.provider, c.method, c.path, op, ok)
		}
	}
	for name, b := range LocalRoutes() {
		if op, ok := b.Op("POST", "chat/completions"); !ok || op.Cap != "max_tokens" {
			t.Errorf("local route %s: %+v %v", name, op, ok)
		}
	}
}

func TestLLMRecordsAreValidated(t *testing.T) {
	bad := []vault.Record{
		{ID: "x", Kind: vault.KindLLM, Provider: "nope"},
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", BaseURL: "https://evil.example.test"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "http://api.example.test/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://127.0.0.1/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://api.example.test/v1?x=1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://u:p@api.example.test/v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "azure", BaseURL: "https://res.openai.azure.com/openai/../v1"},
		{ID: "x", Kind: vault.KindLLM, Provider: "anthropic", Hosts: []string{"api.anthropic.com"}},
	}
	for _, rec := range bad {
		if _, err := FromRecord(rec); err == nil {
			t.Errorf("FromRecord(%+v) succeeded", rec)
		}
	}
}

func TestHTTPRecords(t *testing.T) {
	b, err := FromRecord(vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "x-api-key", Format: "raw", Methods: []string{"GET"}, Paths: []string{"/v1/"}})
	if err != nil {
		t.Fatal(err)
	}
	if b.Header != "X-Api-Key" || b.Tag != "key" || b.Route != "" {
		t.Fatalf("binding %+v", b)
	}
	if !b.Permits("GET", "/v1/forecast") || b.Permits("POST", "/v1/forecast") || b.Permits("GET", "/admin") {
		t.Fatal("Permits does not follow the methods and paths")
	}
	if !b.Permits("GET", "/v1/") || b.Permits("GET", "/v1") {
		t.Fatal("a prefix ending in a slash must permit only what lies under it, not its parent")
	}
	pre, _ := FromRecord(vault.Record{ID: "p", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1"}})
	if !pre.Permits("GET", "/v1") || !pre.Permits("GET", "/v1/x") || pre.Permits("GET", "/v1-admin") {
		t.Fatal("a path prefix must end at a segment")
	}
	open, _ := FromRecord(vault.Record{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"})
	if !open.Permits("DELETE", "/anything") {
		t.Fatal("a binding without methods or paths should permit everything")
	}
	bad := []vault.Record{
		{ID: "w", Kind: vault.KindHTTP, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"localhost"}, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"printer.local"}, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"*.example.test"}, Header: "Authorization", Format: "bearer"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Host", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Cookie", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Proxy-Authorization", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Bad Header", Format: "raw"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "X-Key", Format: "basic-password"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "query"},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"get"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"v1"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1/../admin"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1;x/"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{`/v1\x/`}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Paths: []string{"/v1%2f/"}},
		{ID: "w", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer", Provider: "openai"},
	}
	for _, rec := range bad {
		if _, err := FromRecord(rec); err == nil {
			t.Errorf("FromRecord(%+v) succeeded", rec)
		}
	}
}

func TestLocalRoutesAreReservedIDs(t *testing.T) {
	for name, b := range LocalRoutes() {
		if vault.ValidID(name) {
			t.Errorf("local route %s is a valid secret id", name)
		}
		if !b.Local || b.Upstream.Hostname() != "127.0.0.1" || b.Header != "" {
			t.Errorf("local route %s: %+v", name, b)
		}
	}
}

func TestValidValueFor(t *testing.T) {
	user, _ := FromRecord(vault.Record{ID: "s", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "basic-user"})
	if err := ValidValueFor(user, []byte("user:with-colon")); err == nil {
		t.Fatal("a basic-auth user with a colon was accepted")
	}
	if err := ValidValueFor(user, []byte("plain-user-value")); err != nil {
		t.Fatal(err)
	}
}
```

`keyd/internal/keys/inspect_test.go`:
```go
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/keys/`
Expected: FAIL — `[build failed]`, starting `internal/keys/inspect_test.go:14:46: undefined: Binding`.

- [ ] **Step 3: Implement bindings, the registry and inspection**

`keyd/internal/keys/binding.go`:
```go
// Package keys is keyd's surrogate registry: what each secret is bound to, the surrogates minted
// for each cell, and the inspection that decides whether a request may carry them.
package keys

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type Format string

const (
	Bearer        Format = "bearer"
	Raw           Format = "raw"
	BasicUser     Format = "basic-user"
	BasicPassword Format = "basic-password"
)

// Op is one gateway operation: a method and a path under the route's base URL, without a
// leading slash. Model marks ops whose first capture group names the model. Body names the API
// whose JSON the op takes, which says where a request carries images; Cap is the field the
// provider reads the output cap from, empty when the op writes no output; Free marks ops the
// provider does not bill.
type Op struct {
	Method string
	Path   *regexp.Regexp
	Model  bool
	Body   string
	Cap    string
	Free   bool
}

func (o Op) ModelFrom(p string) string {
	if m := o.Path.FindStringSubmatch(p); len(m) > 1 {
		return m[1]
	}
	return ""
}

// Binding is where a secret may go. HTTP secrets name exact hosts reached over https on 443;
// LLM secrets name a gateway route.
type Binding struct {
	SecretID string
	Tag      string
	Hosts    []string
	Route    string
	Upstream *url.URL
	Local    bool
	Ops      []Op
	Header   string
	Format   Format
	Methods  []string
	Paths    []string
}

func (b Binding) Op(method, p string) (Op, bool) {
	for _, o := range b.Ops {
		if o.Method == method && o.Path.MatchString(p) {
			return o, true
		}
	}
	return Op{}, false
}

// Permits applies an HTTP binding's optional method and path limits to a decoded, clean path. A
// prefix ends at a segment: /v1 permits /v1 and /v1/x, never /v1-admin; /v1/ permits only what
// lies under it.
func (b Binding) Permits(method, p string) bool {
	if len(b.Methods) > 0 && !slices.Contains(b.Methods, method) {
		return false
	}
	if len(b.Paths) == 0 {
		return true
	}
	return slices.ContainsFunc(b.Paths, func(prefix string) bool {
		if strings.HasSuffix(prefix, "/") {
			return strings.HasPrefix(p, prefix)
		}
		return p == prefix || strings.HasPrefix(p, prefix+"/")
	})
}

var (
	// OpenAI's chat completions take max_completion_tokens, the one cap its reasoning models
	// accept; servers that copy OpenAI's API read max_tokens.
	openAIOps     = openAIStyle("max_completion_tokens")
	compatibleOps = openAIStyle("max_tokens")
	anthropicOps  = []Op{
		{Method: "POST", Path: regexp.MustCompile(`^messages$`), Body: "anthropic", Cap: "max_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^messages/count_tokens$`), Body: "anthropic", Free: true},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)},
	}
	googleOps = []Op{
		{Method: "POST", Path: regexp.MustCompile(googleModel + `(?:generateContent|streamGenerateContent)$`), Model: true, Body: "gemini", Cap: "generationConfig.maxOutputTokens"},
		{Method: "POST", Path: regexp.MustCompile(googleModel + `countTokens$`), Model: true, Body: "gemini", Free: true},
		{Method: "POST", Path: regexp.MustCompile(googleModel + `(?:embedContent|batchEmbedContents)$`), Model: true, Body: "embeddings"},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)},
	}
)

const googleModel = `^models/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*):`

func openAIStyle(chatCap string) []Op {
	return []Op{
		{Method: "POST", Path: regexp.MustCompile(`^chat/completions$`), Body: "chat", Cap: chatCap},
		{Method: "POST", Path: regexp.MustCompile(`^completions$`), Body: "completions", Cap: "max_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^responses$`), Body: "responses", Cap: "max_output_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^embeddings$`), Body: "embeddings"},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*(/[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*)?$`)},
	}
}

type preset struct {
	base   string
	header string
	format Format
	tag    string
	ops    []Op
}

// A preset without a base takes the record's BaseURL.
var presets = map[string]preset{
	"anthropic":         {"https://api.anthropic.com/v1", "X-Api-Key", Raw, "ant", anthropicOps},
	"openai":            {"https://api.openai.com/v1", "Authorization", Bearer, "oai", openAIOps},
	"google":            {"https://generativelanguage.googleapis.com/v1beta", "X-Goog-Api-Key", Raw, "gem", googleOps},
	"openai-compatible": {"", "Authorization", Bearer, "llm", compatibleOps},
	"azure":             {"", "Api-Key", Raw, "azr", openAIOps},
}

// LocalRoutes are the gateway's routes to model servers on the Mac's loopback. They carry no
// secret, and their names are reserved secret ids.
func LocalRoutes() map[string]Binding {
	route := func(name, base string) Binding {
		u, _ := url.Parse(base)
		return Binding{Route: name, Upstream: u, Local: true, Ops: compatibleOps}
	}
	return map[string]Binding{
		"lmstudio": route("lmstudio", "http://127.0.0.1:1234/v1"),
		"ollama":   route("ollama", "http://127.0.0.1:11434/v1"),
	}
}

var (
	headerToken = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
	forbidden   = []string{"Host", "Content-Length", "Content-Type", "Transfer-Encoding", "Connection", "Keep-Alive", "Te", "Trailer", "Upgrade", "Cookie", "Set-Cookie", "Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection"}
	methods     = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
)

func FromRecord(rec vault.Record) (Binding, error) {
	switch rec.Kind {
	case vault.KindLLM:
		return llmBinding(rec)
	case vault.KindHTTP:
		return httpBinding(rec)
	}
	return Binding{}, fmt.Errorf("keys: unknown kind %q", rec.Kind)
}

func llmBinding(rec vault.Record) (Binding, error) {
	p, ok := presets[rec.Provider]
	if !ok {
		return Binding{}, fmt.Errorf("keys: unknown provider %q", rec.Provider)
	}
	if len(rec.Hosts) > 0 || rec.Header != "" || rec.Format != "" || len(rec.Methods) > 0 || len(rec.Paths) > 0 {
		return Binding{}, errors.New("keys: an llm secret takes only a provider and, for some providers, a base URL")
	}
	base := p.base
	switch {
	case p.base == "" && rec.BaseURL == "":
		return Binding{}, fmt.Errorf("keys: provider %s needs a base URL", rec.Provider)
	case p.base != "" && rec.BaseURL != "":
		return Binding{}, fmt.Errorf("keys: provider %s has a fixed base URL", rec.Provider)
	case p.base == "":
		base = strings.TrimSuffix(rec.BaseURL, "/")
	}
	u, err := url.Parse(base)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Port() != "" {
		return Binding{}, fmt.Errorf("keys: base URL %q must be https://host/path without a port, user, query or fragment", base)
	}
	if err := policy.ValidBindingHost(u.Hostname()); err != nil {
		return Binding{}, err
	}
	if u.Path != "" && path.Clean(u.Path) != u.Path {
		return Binding{}, fmt.Errorf("keys: base URL path %q is not clean", u.Path)
	}
	return Binding{SecretID: rec.ID, Tag: p.tag, Route: rec.ID, Upstream: u, Ops: p.ops, Header: p.header, Format: p.format}, nil
}

func httpBinding(rec vault.Record) (Binding, error) {
	if rec.Provider != "" || rec.BaseURL != "" {
		return Binding{}, errors.New("keys: an http secret takes hosts, a header and a format")
	}
	if len(rec.Hosts) == 0 || len(rec.Hosts) > 16 {
		return Binding{}, errors.New("keys: an http secret needs 1-16 hosts")
	}
	for _, h := range rec.Hosts {
		if err := policy.ValidBindingHost(h); err != nil {
			return Binding{}, err
		}
	}
	if !headerToken.MatchString(rec.Header) {
		return Binding{}, fmt.Errorf("keys: header %q is not a header name", rec.Header)
	}
	header := http.CanonicalHeaderKey(rec.Header)
	if slices.Contains(forbidden, header) {
		return Binding{}, fmt.Errorf("keys: a surrogate cannot travel in %s", header)
	}
	format := Format(rec.Format)
	switch format {
	case Bearer, Raw:
	case BasicUser, BasicPassword:
		if header != "Authorization" {
			return Binding{}, errors.New("keys: basic-auth formats live in Authorization")
		}
	default:
		return Binding{}, fmt.Errorf("keys: format %q: want bearer, raw, basic-user or basic-password", rec.Format)
	}
	for _, m := range rec.Methods {
		if !slices.Contains(methods, m) {
			return Binding{}, fmt.Errorf("keys: method %q", m)
		}
	}
	for _, p := range rec.Paths {
		clean := path.Clean(p)
		if !strings.HasPrefix(p, "/") || clean != strings.TrimSuffix(p, "/") && clean != p || !printable(p) || strings.ContainsAny(p, `;\%`) {
			return Binding{}, fmt.Errorf("keys: path prefix %q must be a clean absolute path of printable ASCII without ; \\ or %%", p)
		}
	}
	return Binding{
		SecretID: rec.ID,
		Tag:      "key",
		Hosts:    slices.Clone(rec.Hosts),
		Header:   header,
		Format:   format,
		Methods:  slices.Clone(rec.Methods),
		Paths:    slices.Clone(rec.Paths),
	}, nil
}

func printable(s string) bool {
	return !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r > 0x7e })
}

// ValidValueFor adds the binding's own limits to vault.ValidValue.
func ValidValueFor(b Binding, value []byte) error {
	if err := vault.ValidValue(value); err != nil {
		return err
	}
	if b.Format == BasicUser && strings.Contains(string(value), ":") {
		return errors.New("keys: a basic-auth user cannot contain a colon")
	}
	return nil
}
```

`keyd/internal/keys/registry.go`:
```go
package keys

import (
	"sync"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

// Entry is one minted surrogate. Token is the surrogate itself and never leaves keyd except in
// the admin reply that hands it to the cell; ID names it everywhere else.
type Entry struct {
	Token   string
	ID      string
	Cell    string
	Binding Binding
}

type Registry struct {
	mu      sync.RWMutex
	byToken map[string]Entry
}

func NewRegistry() *Registry {
	return &Registry{byToken: map[string]Entry{}}
}

func (r *Registry) Mint(cell string, b Binding) (Entry, error) {
	token, err := surrogate.Mint(b.Tag)
	if err != nil {
		return Entry{}, err
	}
	e := Entry{Token: token, ID: surrogate.ID(token), Cell: cell, Binding: b}
	r.mu.Lock()
	r.byToken[token] = e
	r.mu.Unlock()
	return e, nil
}

func (r *Registry) Lookup(token string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.byToken[token]
	return e, ok
}

func (r *Registry) ForCell(cell string) []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []Entry
	for _, e := range r.byToken {
		if e.Cell == cell {
			out = append(out, e)
		}
	}
	return out
}

// RevokeSecret drops every surrogate of the secret, in every cell: a replaced or deleted secret
// must not keep surrogates minted under its old binding.
func (r *Registry) RevokeSecret(secretID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for token, e := range r.byToken {
		if e.Binding.SecretID == secretID {
			delete(r.byToken, token)
			n++
		}
	}
	return n
}

// RevokeCell drops every surrogate of the cell and returns how many there were.
func (r *Registry) RevokeCell(cell string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for token, e := range r.byToken {
		if e.Cell == cell {
			delete(r.byToken, token)
			n++
		}
	}
	return n
}
```

`keyd/internal/keys/inspect.go`:
```go
package keys

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

const (
	ReasonUnknownSurrogate   = "unknown-surrogate"
	ReasonMisplacedSurrogate = "misplaced-surrogate"
	ReasonSurrogatePolicy    = "surrogate-policy"
)

// Dest is where a request goes: Scheme "https" for a host keyd terminates, "http" for a plain
// request, "gateway" for an LLM route.
type Dest struct {
	Cell   string
	Scheme string
	Host   string
	Route  string
}

type Verdict struct {
	Allow       bool
	Reason      string
	Swaps       []Entry
	SecretID    string
	SurrogateID string
}

type occurrence struct {
	token  string
	header string
	basic  bool
}

// Inspect finds every surrogate-shaped token in the request line, its host included, and the
// headers. Each must be a surrogate of this cell, bound to this destination, appear exactly once,
// and sit exactly in its bound header in its bound format; otherwise the request is refused.
func (r *Registry) Inspect(d Dest, method string, u *url.URL, h http.Header) Verdict {
	occ := scan(u, h)
	var v Verdict
	for _, token := range order(occ) {
		e, ok := r.Lookup(token)
		if !ok {
			return Verdict{Reason: ReasonUnknownSurrogate, SurrogateID: surrogate.ID(token)}
		}
		deny := func(reason string) Verdict {
			return Verdict{Reason: reason, SecretID: e.Binding.SecretID, SurrogateID: e.ID}
		}
		if e.Cell != d.Cell || !bound(e.Binding, d) || !placed(e, occ, h) {
			return deny(ReasonMisplacedSurrogate)
		}
		if e.Binding.Route == "" && !permitted(e.Binding, method, u, h) {
			return deny(ReasonSurrogatePolicy)
		}
		v.Swaps = append(v.Swaps, e)
		if v.SurrogateID == "" {
			v.SecretID, v.SurrogateID = e.Binding.SecretID, e.ID
		}
	}
	v.Allow = true
	return v
}

// permitted applies an HTTP binding's method and path limits. A limited binding matches only a path
// every server reads the same way: decoded, clean (one trailing slash allowed), printable ASCII,
// without ; or a backslash, and with no encoded dot, slash, backslash, percent or NUL in the raw
// path. A method limit also refuses the headers and the _method parameter that make a server treat
// a request as another method.
func permitted(b Binding, method string, u *url.URL, h http.Header) bool {
	if len(b.Paths) > 0 && !unambiguousPath(u) {
		return false
	}
	if len(b.Methods) > 0 && overridesMethod(u, h) {
		return false
	}
	return b.Permits(method, u.Path)
}

var ambiguousEscapes = []string{"%2e", "%2f", "%5c", "%25", "%00"}

func unambiguousPath(u *url.URL) bool {
	raw := strings.ToLower(u.EscapedPath())
	if slices.ContainsFunc(ambiguousEscapes, func(e string) bool { return strings.Contains(raw, e) }) {
		return false
	}
	p := u.Path
	if !strings.HasPrefix(p, "/") || !printable(p) || strings.ContainsAny(p, `;\`) {
		return false
	}
	clean := path.Clean(p)
	return p == clean || clean != "/" && p == clean+"/"
}

var overrideHeaders = []string{"X-Http-Method-Override", "X-Http-Method", "X-Method-Override"}

func overridesMethod(u *url.URL, h http.Header) bool {
	if slices.ContainsFunc(overrideHeaders, func(name string) bool { return len(h.Values(name)) > 0 }) {
		return true
	}
	for _, pair := range strings.FieldsFunc(u.RawQuery, func(r rune) bool { return r == '&' || r == ';' }) {
		key, _, _ := strings.Cut(pair, "=")
		if strings.EqualFold(unescape(key), "_method") {
			return true
		}
	}
	return false
}

// unescape decodes every valid %XX and leaves anything else as it is, so one bad escape cannot
// hide the rest of a query.
func unescape(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func bound(b Binding, d Dest) bool {
	if b.Route != "" {
		return d.Scheme == "gateway" && d.Route == b.Route
	}
	return d.Scheme == "https" && slices.Contains(b.Hosts, d.Host)
}

func placed(e Entry, occ []occurrence, h http.Header) bool {
	var mine []occurrence
	for _, o := range occ {
		if o.token == e.Token {
			mine = append(mine, o)
		}
	}
	b := e.Binding
	if len(mine) != 1 || mine[0].header != b.Header || len(h.Values(b.Header)) != 1 {
		return false
	}
	value := h.Get(b.Header)
	switch b.Format {
	case Raw:
		return !mine[0].basic && value == e.Token
	case Bearer:
		scheme, rest, ok := strings.Cut(value, " ")
		return !mine[0].basic && ok && strings.EqualFold(scheme, "Bearer") && rest == e.Token
	case BasicUser, BasicPassword:
		user, pass, ok := decodeBasic(value)
		if !ok || !mine[0].basic {
			return false
		}
		if b.Format == BasicUser {
			return user == e.Token
		}
		return pass == e.Token
	}
	return false
}

func scan(u *url.URL, h http.Header) []occurrence {
	var out []occurrence
	inURL := map[string]bool{}
	for _, part := range []string{u.Host, u.EscapedPath(), u.Path, u.RawQuery, unescape(u.RawQuery)} {
		for _, t := range surrogate.Find(part) {
			if !inURL[t] {
				inURL[t] = true
				out = append(out, occurrence{token: t})
			}
		}
	}
	names := make([]string, 0, len(h))
	for name := range h {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		canonical := http.CanonicalHeaderKey(name)
		for _, t := range surrogate.Find(name) {
			out = append(out, occurrence{token: t, header: "name:" + name})
		}
		for _, value := range h[name] {
			for _, t := range surrogate.Find(value) {
				out = append(out, occurrence{token: t, header: canonical})
			}
			if user, pass, ok := decodeBasic(value); ok {
				for _, t := range surrogate.Find(user + "\n" + pass) {
					out = append(out, occurrence{token: t, header: canonical, basic: true})
				}
			}
		}
	}
	return out
}

func order(occ []occurrence) []string {
	var tokens []string
	for _, o := range occ {
		if !slices.Contains(tokens, o.token) {
			tokens = append(tokens, o.token)
		}
	}
	return tokens
}

func decodeBasic(value string) (user, pass string, ok bool) {
	scheme, encoded, found := strings.Cut(value, " ")
	if !found || !strings.EqualFold(scheme, "Basic") {
		return "", "", false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", "", false
	}
	return strings.Cut(string(raw), ":")
}

// ApplySwaps rewrites each bound header with the real value, keeping its format.
func ApplySwaps(h http.Header, swaps []Entry, value func(secretID string) ([]byte, error)) error {
	for _, e := range swaps {
		real, err := value(e.Binding.SecretID)
		if err != nil {
			return err
		}
		b := e.Binding
		switch b.Format {
		case Raw:
			h.Set(b.Header, string(real))
		case Bearer:
			h.Set(b.Header, "Bearer "+string(real))
		case BasicUser, BasicPassword:
			user, pass, _ := decodeBasic(h.Get(b.Header))
			if b.Format == BasicUser {
				user = string(real)
			} else {
				pass = string(real)
			}
			h.Set(b.Header, "Basic "+base64.StdEncoding.EncodeToString([]byte(user+":"+pass)))
		}
	}
	return nil
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/keys/`
Expected: `ok` (9 tests; `TestInspect` covers 50 placements).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/keys
git commit -m "feat(keyd): surrogate registry, bindings and header swap"
```

---
