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
	if os.Getenv("KEYD_EARLIER_BIN") == "" {
		storeLegacy(t, k.Keychain, id, value)
		return
	}
	items := k.addEarlier(t, id, value)
	if moved, failed, err := k.Adopt(); err != nil || moved != items || failed != 0 {
		t.Fatalf("Adopt = %d moved, %d failed, %v; want %d moved", moved, failed, err, items)
	}
}

// addEarlier stores value under the access list of the keyd that KEYD_EARLIER_BIN names, as it
// stored values before bindings, and returns how many items that took.
func (k signedKeychain) addEarlier(t *testing.T, id string, value []byte) int {
	t.Helper()
	earlier := os.Getenv("KEYD_EARLIER_BIN")
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
		// The earlier keyd's own items carry its team's partition, as keyd's do.
		tempkeychain.Security(t, "set-generic-password-partition-list", "-S", "teamid:87FD3FSZBG", "-s", k.Service,
			"-a", account, "-k", k.password, k.path)
	}
	if _, err := k.find(context.Background(), id); err == nil {
		t.Fatal("keyd read an item under the earlier keyd's access list before adopting it")
	}
	return len(items)
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
	if mark, ok := parseMarker(k.head(t, markerAccount)); !ok || mark.state != markerDone {
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
	if err := k.add(ctx, markerAccount, running(legacyRecords...)); err != nil {
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

// A record the migration began with, whose index entry now names another destination, is listed as
// rebound at every start and at its first use, and its unbound head is retired once the migration
// ends.
func TestSignedMigrationTellsARecordChangedOutsideKeydApart(t *testing.T) {
	k := newSignedKeychain(t)
	k.storeEarlier(t, "deepseek", []byte("sk-legacy-deepseek-value"))
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := k.add(ctx, markerAccount, running(legacyRecords...)); err != nil {
		t.Fatal(err)
	}
	index := writeIndex(t, beforeUpgrade, movedDeepseek)
	for run := range 2 {
		v := k.open(t, index)
		if m := v.MigrateBindings(); len(m.Bound)+len(m.Reenter) != 0 || !slices.Equal(m.Rebound, []string{"deepseek"}) || !m.Done {
			t.Fatalf("start %d = %+v", run+1, m)
		}
		assertRebound(t, v)
	}
	if head := k.head(t, "deepseek"); head != retiredHead {
		t.Fatalf("deepseek's head is %q", head)
	}
}

// With no marker, the helper's listing finds a bound item the index does not name, so the migration
// closes instead of beginning for an index that names only an unbound record.
func TestSignedMigrationBeginsOnlyOverAKeychainWithNoBoundItem(t *testing.T) {
	k := newSignedKeychain(t)
	if err := k.Put("weather", longValue(40), bindingOf(weatherRecord)); err != nil {
		t.Fatal(err)
	}
	k.storeEarlier(t, "deepseek", []byte("sk-legacy-deepseek-value"))
	planted := k.head(t, "deepseek")
	v := k.open(t, writeIndex(t, beforeUpgrade, movedDeepseek))
	if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
		t.Fatalf("migration = %+v", m)
	}
	if head := k.head(t, "deepseek"); head != planted {
		t.Fatalf("deepseek's head became %q", head)
	}
}

// Items the security tool made carry its partition, not keyd's team's, so keyd cannot read them
// without a prompt: a staged copy and, with an earlier keyd, an item of that keyd's. Adopt counts
// them, leaves them as they are and still moves the items after them.
func TestSignedAdoptMovesPastItemsItCannotRead(t *testing.T) {
	k := newSignedKeychain(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	tempkeychain.Security(t, "add-generic-password", "-s", k.Service+".moving", "-a", "aaa-unreadable.0", "-w", "9999:6162", "-T", self, k.path)
	unreadable, moves := 1, 0
	if earlier := os.Getenv("KEYD_EARLIER_BIN"); earlier != "" {
		tempkeychain.Security(t, "add-generic-password", "-s", k.Service, "-a", "aaa-unreadable", "-w", "keyd:9999:1", "-T", earlier, k.path)
		unreadable++
		moves = k.addEarlier(t, "deepseek", []byte("sk-legacy-deepseek-value"))
	}
	moved, failed, err := k.Adopt()
	if err != nil || moved != moves || failed != unreadable {
		t.Fatalf("Adopt = %d moved, %d failed, %v; want %d moved, %d failed", moved, failed, err, moves, unreadable)
	}
	if moves > 0 {
		if head := k.head(t, "deepseek"); !strings.HasPrefix(head, "keyd:") {
			t.Fatalf("the adopted item holds %q", head)
		}
		if _, err := k.find(context.Background(), "aaa-unreadable"); err == nil {
			t.Fatal("keyd read the item it could not adopt")
		}
	}
	if moved, failed, err := k.Adopt(); err != nil || moved != 0 || failed != unreadable {
		t.Fatalf("a second Adopt = %d moved, %d failed, %v", moved, failed, err)
	}
}
