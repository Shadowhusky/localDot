package vault

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	_ "github.com/shadowhusky/localdot/keyd/internal/keydinfo"
	"github.com/shadowhusky/localdot/keyd/internal/tempkeychain"
)

// These run the binding migration through the native helper against a keychain the test makes.
// KEYD_SIGNED_VAULT=1 asks for them in a vault test executable signed as keyd (scripts/deploy.sh
// signs one), which is then both the daemon and its helper. KEYD_EARLIER_BIN, if set, names a keyd
// signed before generation 2: the legacy items then get its access list, as the keyd before
// bindings stored them, and keyd adopts them before it migrates.
type signedKeychain struct {
	*Keychain
	path     string
	password string
}

func newSignedKeychain(t *testing.T) signedKeychain {
	t.Helper()
	if os.Getenv("KEYD_SIGNED_VAULT") != "1" {
		t.Skip("needs this test executable signed as keyd; set KEYD_SIGNED_VAULT=1")
	}
	path, password := tempkeychain.New(t)
	k := NewKeychain("localdot-keyd-test")
	k.configureCommand = func(cmd *exec.Cmd) {
		cmd.Env = append(cmd.Env, "KEYD_TEST_KEYCHAIN="+path)
		cmd.Stderr = os.Stderr
	}
	if err := k.Check(); err != nil {
		t.Fatal(err)
	}
	if err := k.Claim(); err != nil {
		t.Fatal(err)
	}
	return signedKeychain{k, path, password}
}

// storeEarlier stores value as the keyd before bindings did, then lets keyd adopt it.
func (k signedKeychain) storeEarlier(t *testing.T, id string, value []byte) {
	t.Helper()
	earlier := os.Getenv("KEYD_EARLIER_BIN")
	if earlier == "" {
		storeLegacy(t, k.Keychain, id, value)
		return
	}
	gen, err := newWriteID()
	if err != nil {
		t.Fatal(err)
	}
	n := (len(value) + chunkBytes - 1) / chunkBytes
	items := map[string]string{id: fmt.Sprintf("keyd:%s:%d", gen, n)}
	for i := range n {
		items[chunkAccount(id, i)] = gen + ":" + hex.EncodeToString(value[i*chunkBytes:min(len(value), (i+1)*chunkBytes)])
	}
	for account, data := range items {
		tempkeychain.Security(t, "add-generic-password", "-s", k.Service, "-a", account, "-w", data, "-T", earlier, k.path)
	}
	// The earlier keyd's own items carry its team's partition, as keyd's do.
	tempkeychain.Security(t, "set-generic-password-partition-list", "-S", "teamid:87FD3FSZBG", "-s", k.Service, "-k", k.password, k.path)
	if _, err := k.find(context.Background(), id); err == nil {
		t.Fatal("keyd read an item under the earlier keyd's access list before adopting it")
	}
	if moved, err := k.Adopt(); err != nil || moved != len(items) {
		t.Fatalf("Adopt = %d, %v; want %d", moved, err, len(items))
	}
}

func (k signedKeychain) open(t *testing.T, index string) *Vault {
	t.Helper()
	v, err := Open(k.Keychain, index)
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func (k signedKeychain) head(t *testing.T, id string) string {
	t.Helper()
	head, err := k.find(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return head
}

// A legacy item keyd can prove it wrote is bound by rewriting its head in place, reads whole, and
// the marker item records the migration as done.
func TestSignedMigrationBindsAProvenItem(t *testing.T) {
	k := newSignedKeychain(t)
	short, long := []byte("sk-legacy-deepseek-value"), longValue(3000)
	k.storeEarlier(t, "deepseek", short)
	k.storeEarlier(t, "weather", long)
	v := k.open(t, writeIndex(t, beforeUpgrade, legacyRecords...))
	if m := v.MigrateBindings(); !slices.Equal(m.Bound, []string{"deepseek", "weather"}) || !m.Done {
		t.Fatalf("migration = %+v", m)
	}
	for i, rec := range legacyRecords {
		if got, err := v.Value(rec.ID); err != nil || !bytes.Equal(got, [][]byte{short, long}[i]) {
			t.Fatalf("%s: %d bytes, %v", rec.ID, len(got), err)
		}
		if !strings.HasSuffix(k.head(t, rec.ID), ":"+bindingOf(rec)) {
			t.Fatalf("%s head %q", rec.ID, k.head(t, rec.ID))
		}
	}
	if state, _, ok := parseMarker(k.head(t, markerAccount)); !ok || state != markerDone {
		t.Fatalf("marker %q", k.head(t, markerAccount))
	}
}

// An item planted after the migration finished stays refused, untouched.
func TestSignedMigrationRefusesAPlantedItem(t *testing.T) {
	k := newSignedKeychain(t)
	k.storeEarlier(t, "weather", longValue(40))
	index := writeIndex(t, beforeUpgrade, legacyRecords...)
	if m := k.open(t, index).MigrateBindings(); !m.Done {
		t.Fatalf("first migration = %+v", m)
	}
	k.storeEarlier(t, "deepseek", []byte("sk-planted-value-of-a-key"))
	planted := k.head(t, "deepseek")
	v := k.open(t, index)
	if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) {
		t.Fatalf("second migration = %+v", m)
	}
	if _, err := v.Value("deepseek"); !errors.Is(err, ErrReenter) || k.head(t, "deepseek") != planted {
		t.Fatalf("the planted item: %v", err)
	}
}

// A finished migration changes nothing on a later start.
func TestSignedMigrationRunsOnce(t *testing.T) {
	k := newSignedKeychain(t)
	k.storeEarlier(t, "deepseek", []byte("sk-legacy-deepseek-value"))
	index := writeIndex(t, beforeUpgrade, deepseekRecord)
	if m := k.open(t, index).MigrateBindings(); !m.Done || len(m.Bound) != 1 {
		t.Fatalf("first migration = %+v", m)
	}
	heads := []string{k.head(t, "deepseek"), k.head(t, "deepseek.0"), k.head(t, markerAccount)}
	v := k.open(t, index)
	if m := v.MigrateBindings(); len(m.Bound)+len(m.Reenter)+len(m.Rebound) != 0 || !m.Done {
		t.Fatalf("second migration = %+v", m)
	}
	if now := []string{k.head(t, "deepseek"), k.head(t, "deepseek.0"), k.head(t, markerAccount)}; !slices.Equal(now, heads) {
		t.Fatalf("the second start changed %v to %v", heads, now)
	}
	if got, err := v.Value("deepseek"); err != nil || string(got) != "sk-legacy-deepseek-value" {
		t.Fatalf("Value = %q, %v", got, err)
	}
}

// A migration cut short after it bound one item resumes with the records it began with.
func TestSignedMigrationCutShortResumes(t *testing.T) {
	k := newSignedKeychain(t)
	k.storeEarlier(t, "deepseek", []byte("sk-legacy-deepseek-value"))
	k.storeEarlier(t, "weather", longValue(40))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := k.add(ctx, markerAccount, markerText(markerRunning, snapshotOf(legacyRecords))); err != nil {
		t.Fatal(err)
	}
	gen, count, _, _ := parseHead(k.head(t, "weather"))
	if err := k.add(ctx, "weather", itemHead(gen, count, bindingOf(weatherRecord))); err != nil {
		t.Fatal(err)
	}
	v := k.open(t, writeIndex(t, beforeUpgrade, legacyRecords...))
	if m := v.MigrateBindings(); !slices.Equal(m.Bound, []string{"deepseek"}) || !m.Done {
		t.Fatalf("resumed migration = %+v", m)
	}
	for _, id := range []string{"deepseek", "weather"} {
		if _, err := v.Value(id); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
}
