package keys

import (
	"net/http"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Part 5a's first-class bearer providers (P5a-R31): a fixed base URL, the surrogate as a bearer
// token, their own tag, and only the operation their official AI SDK package calls, with the cap
// field it sends.
func TestTheFirstClassBearerPresets(t *testing.T) {
	r := NewRegistry()
	for _, c := range []struct {
		provider, upstream, tag, op, body, cap string
	}{
		{"xai", "https://api.x.ai/v1", "xai", "responses", "responses", "max_output_tokens"},
		{"mistral", "https://api.mistral.ai/v1", "mis", "chat/completions", "mistral", "max_tokens"},
		{"deepseek", "https://api.deepseek.com", "dsk", "chat/completions", "chat", "max_tokens"},
		{"groq", "https://api.groq.com/openai/v1", "grq", "chat/completions", "chat", "max_tokens"},
		{"openrouter", "https://openrouter.ai/api/v1", "orr", "chat/completions", "openrouter", "max_tokens"},
	} {
		b, err := FromRecord(vault.Record{ID: "my-" + c.provider, Kind: vault.KindLLM, Provider: c.provider})
		if err != nil {
			t.Fatalf("%s: %v", c.provider, err)
		}
		if b.Route != "my-"+c.provider || b.SecretID != "my-"+c.provider || b.Upstream.String() != c.upstream ||
			b.Header != "Authorization" || b.Format != Bearer || b.Tag != c.tag || b.Local {
			t.Errorf("%s binding %+v", c.provider, b)
		}
		if op, ok := b.Op("POST", c.op); !ok || op.Body != c.body || op.Cap != c.cap || op.Free || op.Model {
			t.Errorf("%s POST %s: %+v %v", c.provider, c.op, op, ok)
		}
		for _, p := range []string{"models", "models/some-model", "models/vendor/some-model"} {
			if _, ok := b.Op("GET", p); !ok {
				t.Errorf("%s GET %s refused", c.provider, p)
			}
		}
		for _, other := range []string{"chat/completions", "responses", "completions", "embeddings", "messages"} {
			if _, ok := b.Op("POST", other); ok && other != c.op {
				t.Errorf("%s lists POST %s, which its package never calls", c.provider, other)
			}
		}
		if _, err := FromRecord(vault.Record{ID: "x", Kind: vault.KindLLM, Provider: c.provider, BaseURL: "https://llm.example.test/v1"}); err == nil {
			t.Errorf("%s took a base URL; its preset fixes it", c.provider)
		}
		e, err := r.Mint("c1", b)
		if err != nil {
			t.Fatal(err)
		}
		d := Dest{Cell: "c1", Scheme: "gateway", Route: b.Route}
		wantAllow(t, c.provider+" as a bearer token", at(t, r, d, "POST", "/x", hdr("Authorization", "Bearer "+e.Token)), 1)
		wantDeny(t, c.provider+" in X-Api-Key", at(t, r, d, "POST", "/x", hdr("X-Api-Key", e.Token)), ReasonMisplacedSurrogate)
		wantDeny(t, c.provider+" in the query", at(t, r, d, "POST", "/x?key="+e.Token, http.Header{}), ReasonMisplacedSurrogate)
	}
	tags := map[string]string{}
	for name, p := range presets {
		if other, dup := tags[p.tag]; dup {
			t.Errorf("presets %s and %s share the tag %s", name, other, p.tag)
		}
		tags[p.tag] = name
	}
}

// Vendors' Anthropic routes (Z.ai, Kimi, MiniMax, Alibaba, DeepSeek) document ANTHROPIC_AUTH_TOKEN,
// so the surrogate travels as a bearer token to the base URL the record names, under the same rules
// as any other user base URL, and only for Anthropic's message, token count and model listing ops.
func TestTheAnthropicCompatiblePreset(t *testing.T) {
	rec := vault.Record{ID: "my-anc", Kind: vault.KindLLM, Provider: "anthropic-compatible", BaseURL: "https://api.z.ai/api/anthropic/v1/"}
	b, err := FromRecord(rec)
	if err != nil {
		t.Fatal(err)
	}
	if b.Route != "my-anc" || b.SecretID != "my-anc" || b.Upstream.String() != "https://api.z.ai/api/anthropic/v1" ||
		b.Header != "Authorization" || b.Format != Bearer || b.Tag != "anc" || b.Local {
		t.Fatalf("anthropic-compatible binding %+v", b)
	}
	for _, c := range []struct {
		method, path, body, cap string
		free                    bool
	}{
		{"POST", "messages", "anthropic", "max_tokens", false},
		{"POST", "messages/count_tokens", "anthropic", "", true},
		{"GET", "models", "", "", false},
		{"GET", "models/glm-5.3-flash", "", "", false},
	} {
		if op, ok := b.Op(c.method, c.path); !ok || op.Body != c.body || op.Cap != c.cap || op.Free != c.free || op.Model {
			t.Errorf("%s %s: %+v %v", c.method, c.path, op, ok)
		}
	}
	for _, p := range []string{"chat/completions", "responses", "completions", "embeddings", "files", "messages/batches", "models"} {
		if _, ok := b.Op("POST", p); ok {
			t.Errorf("POST %s is allowed", p)
		}
	}
	for _, p := range []string{"messages/batches", "files", "models/a/b"} {
		if _, ok := b.Op("GET", p); ok {
			t.Errorf("GET %s is allowed", p)
		}
	}

	for _, base := range []string{
		"",
		"http://api.z.ai/api/anthropic/v1",
		"https://api.z.ai:8443/api/anthropic/v1",
		"https://api.z.ai:/api/anthropic/v1",
		"https://127.0.0.1/v1",
		"https://10.0.0.8/v1",
		"https://localhost/v1",
		"https://printer.local/v1",
		"https://API.Z.AI/api/anthropic/v1",
		"https://api.z.ai/api/anthropic/v1?beta=1",
		"https://api.z.ai/api/anthropic/v1#x",
		"https://user:pass@api.z.ai/api/anthropic/v1",
		"https://token@api.z.ai/api/anthropic/v1",
		"https://api.z.ai/api/../anthropic/v1",
	} {
		if _, err := FromRecord(vault.Record{ID: "x", Kind: vault.KindLLM, Provider: "anthropic-compatible", BaseURL: base}); err == nil {
			t.Errorf("anthropic-compatible took base URL %q", base)
		}
	}

	r := NewRegistry()
	e, err := r.Mint("c1", b)
	if err != nil {
		t.Fatal(err)
	}
	d := Dest{Cell: "c1", Scheme: "gateway", Route: b.Route}
	wantAllow(t, "anthropic-compatible as a bearer token", at(t, r, d, "POST", "/x", hdr("Authorization", "Bearer "+e.Token)), 1)
	wantDeny(t, "anthropic-compatible in X-Api-Key", at(t, r, d, "POST", "/x", hdr("X-Api-Key", e.Token)), ReasonMisplacedSurrogate)
	wantDeny(t, "anthropic-compatible in the query", at(t, r, d, "POST", "/x?key="+e.Token, http.Header{}), ReasonMisplacedSurrogate)

	tags := 0
	for _, p := range presets {
		if p.tag == "anc" {
			tags++
		}
	}
	if tags != 1 {
		t.Errorf("%d presets use the tag anc", tags)
	}
}
