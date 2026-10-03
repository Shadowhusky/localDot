package keys

import (
	"net/url"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func TestBindingIdentityPinsDestinationAndAuthorizationNotRecordTimes(t *testing.T) {
	rec := vault.Record{ID: "provider", Kind: vault.KindLLM, Provider: "openai-compatible", BaseURL: "https://fixture.example/v1"}
	b, err := FromRecord(rec)
	if err != nil {
		t.Fatal(err)
	}
	want := BindingIdentity(b)
	rec.UpdatedAt = time.Now()
	rotated, err := FromRecord(rec)
	if err != nil || BindingIdentity(rotated) != want {
		t.Fatal("record metadata changed policy identity")
	}
	for _, change := range []func(*Binding){
		func(b *Binding) { b.Upstream, _ = url.Parse("https://elsewhere.example/v1") },
		func(b *Binding) { b.Upstream.Path = "/other" },
		func(b *Binding) { b.Header = "X-New-Key" },
		func(b *Binding) { b.Format = Raw },
		func(b *Binding) { b.Route = "other" },
		func(b *Binding) { b.Ops[0].Cap = "max_output_tokens" },
	} {
		changed := b.clone()
		change(&changed)
		if BindingIdentity(changed) == want {
			t.Fatal("changed binding reused identity")
		}
	}
}
