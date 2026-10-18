package admin

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestGeneralSecretsStayPrivateAndCannotBeMinted(t *testing.T) {
	f := newFixture(t)
	fields := map[string]any{"kind": "secret", "metadata": map[string]string{"label": "Build license", "description": "License file for the design app"}}
	for _, value := range []string{"x", "  multiline\n密钥\n", strings.Repeat("a", 8192)} {
		if code, body := f.sealedPut(t, "license", fields, value); code != 200 {
			t.Fatalf("save: %d %v", code, body)
		}
	}
	for _, value := range []string{"", "a\x00b", strings.Repeat("密", 3000)} {
		if code, _ := f.sealedPut(t, "license", fields, value); code == 200 {
			t.Fatal("accepted invalid general value")
		}
	}
	_, list := f.call(t, "GET", "/v1/secrets", nil)
	rec := list["secrets"].([]any)[0].(map[string]any)
	if rec["kind"] != "secret" || rec["usage"] != nil {
		t.Fatalf("bad general metadata: %v", rec)
	}
	raw, _ := json.Marshal(list)
	if strings.Contains(string(raw), strings.Repeat("a", 80)) {
		t.Fatal("metadata exposed value")
	}
	for _, role := range []string{"brain", "desktop", "browser", "service"} {
		code, _ := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "general-test", "role": role, "port": 49001, "secrets": []string{"license"}})
		if code == 200 {
			t.Fatalf("minted general secret for %s", role)
		}
	}
	fields["header"] = "Authorization"
	if code, _ := f.sealedPut(t, "other", fields, "arbitrary-key"); code == 200 {
		t.Fatal("accepted hidden HTTP binding")
	}
}
