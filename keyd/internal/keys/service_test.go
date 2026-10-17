package keys

import (
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"testing"
)

func TestServiceBindingsKeepEveryProviderOnItsOwnAPI(t *testing.T) {
	for provider, p := range presets {
		rec := vault.Record{ID: "test", Kind: vault.KindLLM, Provider: provider}
		if p.base == "" {
			rec.BaseURL = "https://api.example.test/custom/v1"
		}
		b, err := ServiceBinding(rec)
		if err != nil {
			t.Fatal(err)
		}
		gateway, _ := FromRecord(rec)
		if b.Route != "" || b.Upstream != nil || len(b.Ops) != 0 || len(b.Hosts) != 1 || b.Hosts[0] != gateway.Upstream.Hostname() || b.Header != gateway.Header || b.Format != gateway.Format {
			t.Fatalf("bad service view for %s", provider)
		}
		if !b.Permits("POST", gateway.Upstream.Path+"/files") {
			t.Fatalf("service operation not supported for %s", provider)
		}
		if gateway.Upstream.Path != "" && b.Permits("POST", "/other/files") {
			t.Fatal("escaped provider base path")
		}
		if gateway.Route != rec.ID || len(gateway.Ops) == 0 {
			t.Fatal("changed brain gateway")
		}
	}
}
