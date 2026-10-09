package admin

import (
	"net/http"
	"testing"
)

func TestPushKeyNameIsNotAUserSecret(t *testing.T) {
	f := newFixture(t)
	code, body := f.call(t, "PUT", "/v1/secrets/webpush-vapid", map[string]any{"kind": "llm", "provider": "anthropic", "sealed": map[string]any{}})
	if code != http.StatusBadRequest || body["error"].(map[string]any)["code"] != "bad-request" {
		t.Fatalf("%d %v", code, body)
	}
}
