package admin

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMetadataAndServiceDiscovery(t *testing.T) {
	f := newFixture(t)
	fields := map[string]any{"kind": "llm", "provider": "openai", "metadata": map[string]any{"label": "Studio", "service": "OpenAI", "description": "Search and files"}}
	if code, _ := f.sealedPut(t, "studio", fields, "synthetic-secret"); code != 200 {
		t.Fatal(code)
	}
	_, list := f.call(t, "GET", "/v1/secrets", nil)
	records := list["secrets"].([]any)
	rec := records[0].(map[string]any)
	usage := rec["usage"].(map[string]any)
	if usage["baseURL"] != "https://api.openai.com/v1" || usage["header"] != "Authorization" || usage["format"] != "bearer" {
		t.Fatalf("wrong service metadata: %v", usage)
	}
	if code, _ := f.call(t, "PUT", "/v1/secrets/studio/metadata", map[string]string{"label": "Research", "description": "General API services"}); code != 200 {
		t.Fatal(code)
	}
	_, list = f.call(t, "GET", "/v1/secrets", nil)
	raw, _ := json.Marshal(list)
	if !strings.Contains(string(raw), "Research") || strings.Contains(string(raw), "synthetic-secret") {
		t.Fatal("metadata update did not preserve private inventory")
	}
	if code, _ := f.call(t, "PUT", "/v1/secrets/absent/metadata", map[string]string{"label": "Absent"}); code != 404 {
		t.Fatal(code)
	}
	if code, _ := f.call(t, "PUT", "/v1/secrets/studio/metadata", map[string]string{"label": "bad\nlabel"}); code != 400 {
		t.Fatal(code)
	}
}
