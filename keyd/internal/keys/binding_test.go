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
