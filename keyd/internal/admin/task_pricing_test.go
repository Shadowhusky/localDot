package admin

import (
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func TestTaskPricingAdminWireAndImmutableRetry(t *testing.T) {
	f := newFixture(t)
	if err := f.s.Vault.Put(vault.Record{ID: "provider", Kind: vault.KindLLM, Provider: "openai"}, []byte(fakeKey)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Manager.Open(egress.OpenRequest{CellID: "brain", Role: "brain", Secrets: []string{"provider"}}); err != nil {
		t.Fatal(err)
	}
	price := map[string]any{"v": 1, "routes": []any{map[string]any{"route": "provider", "models": []any{map[string]any{"id": "m", "inputUSDPerMTok": 0, "outputUSDPerMTok": 1, "maxOutputTokens": 10}}}}}
	for _, bad := range []any{nil, map[string]any{"v": 1, "routes": []any{}}, map[string]any{"v": 1, "routes": price["routes"], "binding": "spoof"}} {
		if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", map[string]any{"taskId": "session", "pricing": bad}); code != 400 {
			t.Fatalf("bad pricing status %d", code)
		}
	}
	if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", map[string]any{"taskId": "session", "budgetUSD": nil, "pricing": price}); code != 400 {
		t.Fatalf("explicit null budget: %d", code)
	}
	req := map[string]any{"taskId": "session", "budgetUSD": 5, "pricing": price}
	if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", req); code != 204 {
		t.Fatalf("initialize %d", code)
	}
	if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", map[string]any{"taskId": "session", "budgetUSD": 8}); code != 204 {
		t.Fatalf("raise %d", code)
	}
	if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", req); code != 204 {
		t.Fatalf("retry %d", code)
	}
	info, _ := f.s.Budget.Task("brain")
	if info.LimitUSD != 8 {
		t.Fatal("retry reset raised limit")
	}
	req["budgetUSD"] = 9
	if code, body := f.call(t, "PUT", "/v1/cells/brain/task", req); code != 409 || body["error"].(map[string]any)["code"] != "task-pricing-conflict" {
		t.Fatalf("conflict: %d %v", code, body)
	}
	if code, _ := f.call(t, "DELETE", "/v1/cells/brain/task", nil); code != 204 {
		t.Fatalf("detach %d", code)
	}
	if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", map[string]any{"taskId": "session"}); code != 204 {
		t.Fatalf("reattach %d", code)
	}
	if !f.s.Budget.IsSnapshot("brain") {
		t.Fatal("omitted pricing downgraded existing snapshot")
	}
}
