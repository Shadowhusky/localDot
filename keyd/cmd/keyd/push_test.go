package main

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"github.com/shadowhusky/localdot/keyd/internal/webpush"
)

type loopbackResolver struct{ asked []string }

func (r *loopbackResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.asked = append(r.asked, host)
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}

func pusherFixture(t *testing.T, store vault.Store, index string) (*webpush.Sender, *loopbackResolver, *int) {
	t.Helper()
	dir := t.TempDir()
	path := ""
	if index != "" {
		path = filepath.Join(dir, "secrets.json")
		if err := os.WriteFile(path, []byte(index), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	v, err := vault.Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	log, err := audit.Open(filepath.Join(dir, "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	checks := 0
	guard := netguard.New(func() ([]netip.Prefix, error) { checks++; return nil, nil })
	resolver := &loopbackResolver{}
	return newPusher(store, v, guard, resolver, log), resolver, &checks
}

func TestPushReachesOnlyWhatTheGuardAllows(t *testing.T) {
	pusher, resolver, checks := pusherFixture(t, vault.NewMemory(), "")
	_, err := pusher.Send(context.Background(), webpush.Request{
		Endpoint: "https://web.push.apple.com/device", TTL: 60, Urgency: "normal", Body: "Y2lwaGVydGV4dA",
	})
	if !errors.Is(err, webpush.ErrUnreachable) {
		t.Fatalf("a push host that resolves to loopback must be unreachable, got %v", err)
	}
	if len(resolver.asked) != 1 || resolver.asked[0] != "web.push.apple.com" || *checks == 0 {
		t.Fatalf("the push host must be resolved and checked by the guard: asked %v, checks %d", resolver.asked, *checks)
	}
}

func TestPushKeyStaysInKeydsStore(t *testing.T) {
	store := vault.NewMemory()
	first, _, _ := pusherFixture(t, store, "")
	second, _, _ := pusherFixture(t, store, "")
	a, err := first.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	if b, err := second.PublicKey(); err != nil || b != a {
		t.Fatalf("a restarted keyd must find the same push key: %q %v", b, err)
	}
}

func TestPushKeyGivesWayToAUserSecretOfTheSameName(t *testing.T) {
	index := `{"v":1,"secrets":[{"id":"webpush-vapid","kind":"http","hosts":["api.example.test"],"header":"X-Api-Key","format":"raw","createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}]}`
	pusher, _, _ := pusherFixture(t, vault.NewMemory(), index)
	if _, err := pusher.PublicKey(); !errors.Is(err, webpush.ErrKeyBlocked) {
		t.Fatalf("want ErrKeyBlocked, got %v", err)
	}
}
