package admin

import (
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"net/http/httptest"
	"strings"
	"testing"
)

const admissionTask = "01JXYZ0000000000000000SESS"

func TestModelAdmissionAdminStrictOwnerAndCompareAndSwap(t *testing.T) {
	f := newFixture(t)
	if err := f.s.Vault.Put(vault.Record{ID: "provider", Kind: vault.KindLLM, Provider: "openai"}, []byte(fakeKey)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.s.Manager.Open(egress.OpenRequest{CellID: "brain", Role: "brain", Secrets: []string{"provider"}}); err != nil {
		t.Fatal(err)
	}
	price := map[string]any{"v": 1, "routes": []any{map[string]any{"route": "provider", "models": []any{map[string]any{"id": "m", "inputUSDPerMTok": 1, "outputUSDPerMTok": 1, "maxOutputTokens": 10}}}}}
	if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", map[string]any{"taskId": admissionTask, "pricing": price}); code != 204 {
		t.Fatalf("initialize %d", code)
	}
	code, snap := f.call(t, "GET", "/v1/cells/brain/model-admission", nil)
	if code != 200 || snap["paused"] != true || snap["active"] != float64(0) {
		t.Fatalf("fresh snapshot %d %v", code, snap)
	}
	gen := snap["generationId"].(string)
	epoch := snap["epoch"].(float64)
	for _, body := range []map[string]any{{"taskId": admissionTask, "generationId": gen, "state": "open"}, {"taskId": admissionTask, "generationId": gen, "state": "paused", "expectedEpoch": nil}, {"taskId": admissionTask, "generationId": gen, "state": "paused", "extra": "grant"}, {"taskId": admissionTask, "generationId": gen, "state": "open", "expectedEpoch": 0}, {"taskId": admissionTask, "generationId": gen, "state": "open", "expectedEpoch": 1.5}} {
		if code, _ = f.call(t, "PUT", "/v1/cells/brain/model-admission", body); code != 400 {
			t.Fatalf("bad DTO accepted %d %v", code, body)
		}
	}
	for _, raw := range []string{`{"taskId":"` + admissionTask + `","generationId":"` + gen + `","state":"paused","state":"open","expectedEpoch":1}`, `{"TaskId":"` + admissionTask + `","generationId":"` + gen + `","state":"paused"}`} {
		req := httptest.NewRequest("PUT", "/v1/cells/brain/model-admission", strings.NewReader(raw))
		out := httptest.NewRecorder()
		f.s.Handler().ServeHTTP(out, req)
		if out.Code != 400 {
			t.Fatalf("ambiguous DTO %d", out.Code)
		}
	}
	for _, body := range []map[string]any{{"taskId": "01JXYZ0000000000000000SES2", "generationId": gen, "state": "paused"}, {"taskId": admissionTask, "generationId": strings.Repeat("b", 32), "state": "paused"}, {"taskId": admissionTask, "generationId": gen, "state": "open", "expectedEpoch": epoch + 1}} {
		if code, _ = f.call(t, "PUT", "/v1/cells/brain/model-admission", body); code != 409 {
			t.Fatalf("stale owner accepted %d", code)
		}
	}
	if code, _ = f.call(t, "PUT", "/v1/cells/brain/model-admission", map[string]any{"taskId": admissionTask, "generationId": gen, "state": "open", "expectedEpoch": epoch}); code != 200 {
		t.Fatalf("positive explicit open %d", code)
	}
	if code, _ = f.call(t, "PUT", "/v1/cells/brain/model-admission", map[string]any{"taskId": admissionTask, "generationId": gen, "state": "open", "expectedEpoch": epoch}); code != 409 {
		t.Fatalf("replayed open %d", code)
	}
	if code, _ = f.call(t, "POST", "/v1/cells/brain/revoke", nil); code != 200 {
		t.Fatalf("Stop %d", code)
	}
	if code, _ = f.call(t, "PUT", "/v1/cells/brain/model-admission", map[string]any{"taskId": admissionTask, "generationId": gen, "state": "open", "expectedEpoch": epoch}); code != 409 {
		t.Fatalf("Stop undone %d", code)
	}
}
