package egress

import (
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestServiceCallsReuseProviderKeysAndScrubEchoes(t *testing.T) {
	m, w := newManager(t)
	w.secret(vault.Record{ID: "provider", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://api.example.test/v1"}, realValue)
	var hits atomic.Int32
	seen := make(chan string, 1)
	w.tlsUpstream("api.example.test", echo(&hits, seen))
	o, err := m.Open(OpenRequest{CellID: "svc", Role: "service", Secrets: []string{"provider"}})
	if err != nil {
		t.Fatal(err)
	}
	client := cellClient(w, o)
	resp, body := do(t, client, "POST", "https://api.example.test/v1/files", http.Header{"Authorization": {"Bearer " + o.Surrogates["provider"]}})
	if resp.StatusCode != 200 || <-seen != "Bearer "+realValue {
		t.Fatal("provider key was not delivered")
	}
	if strings.Contains(string(body), realValue) {
		t.Fatal("raw provider key escaped in response")
	}
	for _, path := range []string{"/other", "/v1-admin", "/v1/%2e%2e/other"} {
		resp, _ := do(t, client, "POST", "https://api.example.test"+path, http.Header{"Authorization": {"Bearer " + o.Surrogates["provider"]}})
		if resp.StatusCode == 200 {
			t.Fatalf("allowed %s", path)
		}
	}
	if hits.Load() != 1 {
		t.Fatal("denied requests reached provider")
	}
	if _, res := rawConnectWith(t, o, "elsewhere.example.test:443"); res.StatusCode == 200 {
		t.Fatal("service cell reached unrelated host")
	}
	if _, err = m.DeleteSecret("provider"); err != nil {
		t.Fatal(err)
	}
	resp, _ = do(t, client, "POST", "https://api.example.test/v1/files", http.Header{"Authorization": {"Bearer " + o.Surrogates["provider"]}})
	if resp.StatusCode == 200 {
		t.Fatal("removed key still worked")
	}
	_ = m.Close("svc")
}
