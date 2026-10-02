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
