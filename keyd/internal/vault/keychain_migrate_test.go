package vault

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Before bindings, keyd recorded each secret in the index at its Put and laid its value out as here.
var beforeUpgrade = time.Date(2026, 10, 8, 1, 30, 0, 0, time.UTC)

var (
	deepseekRecord = Record{ID: "deepseek", Kind: KindLLM, Provider: "deepseek"}
	legacyRecords  = []Record{deepseekRecord, weatherRecord}
	// What an index changed outside keyd names for deepseek: another destination.
	movedDeepseek = Record{ID: "deepseek", Kind: KindHTTP, Hosts: []string{"collector.example.test"}, Header: "Authorization", Format: "bearer"}
)

// storeLegacy stores value as a keyd from before bindings did (keyd 46261b9a's Put): its chunks,
// then a head that names their write and count but no binding.
func storeLegacy(t *testing.T, k *Keychain, id string, value []byte) {
	t.Helper()
	gen, err := newWriteID()
	if err != nil {
		t.Fatal(err)
	}
	n := (len(value) + chunkBytes - 1) / chunkBytes
	for i := range n {
		part := value[i*chunkBytes : min(len(value), (i+1)*chunkBytes)]
		if err := k.add(context.Background(), chunkAccount(id, i), gen+":"+hex.EncodeToString(part)); err != nil {
			t.Fatal(err)
		}
	}
	if err := k.add(context.Background(), id, fmt.Sprintf("keyd:%s:%d", gen, n)); err != nil {
		t.Fatal(err)
	}
}

// writeIndex writes an index as keyd writes one, each record timed as of at.
func writeIndex(t *testing.T, at time.Time, records ...Record) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "secrets.json")
	rewriteIndex(t, path, at, records...)
	return path
}

func rewriteIndex(t *testing.T, path string, at time.Time, records ...Record) {
	t.Helper()
	idx := indexFile{V: indexVersion}
	for _, rec := range records {
		rec.CreatedAt, rec.UpdatedAt = at, at
		idx.Secrets = append(idx.Secrets, rec)
	}
	data, err := json.Marshal(idx)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func openAt(t *testing.T, k *Keychain, index string, now time.Time) *Vault {
	t.Helper()
	v, err := Open(k, index)
	if err != nil {
		t.Fatal(err)
	}
	v.now = func() time.Time { return now }
	return v
}

func readItem(t *testing.T, dir, account string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "store", "localdot-keyd-test."+account))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func writeItem(t *testing.T, dir, account, data string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(dir, "store"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "store", "localdot-keyd-test."+account), []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
}

func markerOf(t *testing.T, dir string) (string, []string) {
	t.Helper()
	state, snapshot, ok := parseMarker(readItem(t, dir, markerAccount))
	if !ok {
		t.Fatalf("the marker holds %q", readItem(t, dir, markerAccount))
	}
	return state, snapshot
}

// stores lists the item writes the helper ran since the log was last cleared.
func stores(t *testing.T, dir string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "argv.log"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	var out []string
	for line := range strings.Lines(string(data)) {
		if fields := strings.Fields(line); len(fields) == 4 && fields[1] == "store" {
			out = append(out, fields[3])
		}
	}
	return out
}

func clearLog(t *testing.T, dir string) {
	t.Helper()
	if err := os.Remove(filepath.Join(dir, "argv.log")); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

// lockable makes reads of the item deepseek fail while FAKE_DIR/locked exists, as a locked Keychain
// or a timed-out helper would.
func lockable(t *testing.T, k *Keychain, dir string, locked bool) {
	t.Helper()
	script := strings.Replace(fakeSecurity, `run "$@"`, `[ "$4" = deepseek ] && [ -f "$FAKE_DIR/locked" ] && exit 1; run "$@"`, 1)
	if err := os.WriteFile(k.Path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(dir, "locked")
	if !locked {
		if err := os.Remove(lock); err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		return
	}
	if err := os.WriteFile(lock, nil, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A value a keyd from before bindings stored, under a record the index held when the migration
// began, is bound to that record by rewriting its head alone; the migration is then recorded as done.
func TestMigrationBindsAValueKeydStoredBeforeBindings(t *testing.T) {
	k, dir := fakeKeychain(t)
	short, long := []byte("sk-legacy-deepseek-value"), longValue(3000)
	storeLegacy(t, k, "deepseek", short)
	storeLegacy(t, k, "weather", long)
	chunks := map[string]string{}
	for _, account := range []string{"deepseek.0", "weather.0", "weather.1"} {
		chunks[account] = readItem(t, dir, account)
	}
	if _, err := k.Get("deepseek", bindingOf(deepseekRecord)); !errors.Is(err, ErrReenter) {
		t.Fatalf("before the migration Get = %v", err)
	}
	v := openAt(t, k, writeIndex(t, beforeUpgrade, legacyRecords...), beforeUpgrade.Add(time.Hour))
	m := v.MigrateBindings()
	if !slices.Equal(m.Bound, []string{"deepseek", "weather"}) || len(m.Reenter)+len(m.Rebound) != 0 || !m.Done {
		t.Fatalf("migration = %+v", m)
	}
	for i, rec := range legacyRecords {
		value := [][]byte{short, long}[i]
		if got, err := v.Value(rec.ID); err != nil || !bytes.Equal(got, value) || v.Attention(rec.ID) != "" {
			t.Fatalf("%s after the migration: %q, %v", rec.ID, got, err)
		}
		if head := readItem(t, dir, rec.ID); !strings.HasSuffix(head, ":"+bindingOf(rec)) {
			t.Fatalf("%s holds %q", rec.ID, head)
		}
	}
	for account, data := range chunks {
		if readItem(t, dir, account) != data {
			t.Fatalf("the migration rewrote chunk %s", account)
		}
	}
	if state, snapshot := markerOf(t, dir); state != markerDone || snapshot != nil {
		t.Fatalf("marker %s with %v", state, snapshot)
	}
}

// While it runs, the marker holds the id and binding of every record the index held when the
// migration began, as digests, and nothing else.
func TestMigrationRecordsTheIndexItBeganWith(t *testing.T) {
	k, dir := fakeKeychain(t)
	storeLegacy(t, k, "deepseek", []byte("sk-legacy-deepseek-value"))
	lockable(t, k, dir, true)
	if m := openAt(t, k, writeIndex(t, beforeUpgrade, legacyRecords...), beforeUpgrade).MigrateBindings(); m.Done {
		t.Fatalf("migration = %+v", m)
	}
	want := []string{recordDigest("deepseek", bindingOf(deepseekRecord)), recordDigest("weather", bindingOf(weatherRecord))}
	slices.Sort(want)
	if state, snapshot := markerOf(t, dir); state != markerRunning || !slices.Equal(snapshot, want) {
		t.Fatalf("marker %s with %v, want running with %v", state, snapshot, want)
	}
	if marker := readItem(t, dir, markerAccount); len(want[0]) != 22 || strings.Contains(marker, "deepseek") ||
		strings.Contains(marker, bindingOf(deepseekRecord)[:16]) {
		t.Fatalf("the marker names records in the clear: %q", marker)
	}
}

// An unbound item keyd cannot prove it wrote for the record stays refused, untouched, and is listed
// for re-entry: one planted after the migration finished, one under a record the index gained or
// changed after the migration began, one under a marker that is not keyd's, and every item laid
// out other than as keyd lays one.
func TestMigrationRefusesAnUnboundItemItCannotProve(t *testing.T) {
	value := []byte("sk-planted-value-of-a-key")
	hexOf := func(s string) string { return hex.EncodeToString([]byte(s)) }
	gen := strings.Repeat("ab", 8)
	full := strings.Repeat("A", chunkBytes)
	layouts := map[string]map[string]string{
		"capital hex":          {"deepseek": "keyd:" + gen + ":1", "deepseek.0": gen + ":" + strings.ToUpper(hexOf(string(value)))},
		"another write":        {"deepseek": "keyd:" + gen + ":1", "deepseek.0": strings.Repeat("cd", 8) + ":" + hexOf(string(value))},
		"short write id":       {"deepseek": "keyd:abcd:1", "deepseek.0": "abcd:" + hexOf(string(value))},
		"padded count":         {"deepseek": "keyd:" + gen + ":01", "deepseek.0": gen + ":" + hexOf(string(value))},
		"too many chunks":      {"deepseek": "keyd:" + gen + ":7", "deepseek.0": gen + ":" + hexOf(string(value))},
		"short first chunk":    {"deepseek": "keyd:" + gen + ":2", "deepseek.0": gen + ":" + hexOf("sk-planted"), "deepseek.1": gen + ":" + hexOf("-value-of-a-key")},
		"missing chunk":        {"deepseek": "keyd:" + gen + ":2", "deepseek.0": gen + ":" + hexOf(full)},
		"empty last chunk":     {"deepseek": "keyd:" + gen + ":2", "deepseek.0": gen + ":" + hexOf(full), "deepseek.1": gen + ":"},
		"unprintable value":    {"deepseek": "keyd:" + gen + ":1", "deepseek.0": gen + ":" + hexOf("sk-planted\x01value")},
		"value too short":      {"deepseek": "keyd:" + gen + ":1", "deepseek.0": gen + ":" + hexOf("sk-1")},
		"space at its end":     {"deepseek": "keyd:" + gen + ":1", "deepseek.0": gen + ":" + hexOf("sk-planted-value ")},
		"head of another tool": {"deepseek": "other:" + gen + ":1", "deepseek.0": gen + ":" + hexOf(string(value))},
	}
	for name, items := range layouts {
		t.Run(name, func(t *testing.T) {
			k, dir := fakeKeychain(t)
			storeLegacy(t, k, "weather", longValue(40))
			for account, data := range items {
				writeItem(t, dir, account, data)
			}
			v := openAt(t, k, writeIndex(t, beforeUpgrade, legacyRecords...), beforeUpgrade.Add(time.Hour))
			m := v.MigrateBindings()
			if !slices.Equal(m.Bound, []string{"weather"}) || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
				t.Fatalf("migration = %+v", m)
			}
			assertRefused(t, v, dir, items)
		})
	}

	t.Run("planted after the migration finished", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		storeLegacy(t, k, "weather", longValue(40))
		index := writeIndex(t, beforeUpgrade, legacyRecords...)
		if m := openAt(t, k, index, beforeUpgrade.Add(time.Hour)).MigrateBindings(); !m.Done {
			t.Fatalf("first migration = %+v", m)
		}
		storeLegacy(t, k, "deepseek", value)
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek"), "deepseek.0": readItem(t, dir, "deepseek.0")}
		v := openAt(t, k, index, beforeUpgrade.Add(2*time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
			t.Fatalf("second migration = %+v", m)
		}
		assertRefused(t, v, dir, planted)
	})

	t.Run("a record the index gained after the migration began", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		writeItem(t, dir, markerAccount, markerText(markerRunning, snapshotOf([]Record{weatherRecord})))
		storeLegacy(t, k, "deepseek", value)
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
		v := openAt(t, k, writeIndex(t, beforeUpgrade, deepseekRecord), beforeUpgrade.Add(time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
			t.Fatalf("migration = %+v", m)
		}
		assertRefused(t, v, dir, planted)
	})

	// The index is the user's to write, so its timestamps prove nothing: a record changed while the
	// migration runs, dated before it began, still binds nothing.
	t.Run("a record changed while the migration runs", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		storeLegacy(t, k, "deepseek", value)
		storeLegacy(t, k, "weather", longValue(40))
		index := writeIndex(t, beforeUpgrade, legacyRecords...)
		lockable(t, k, dir, true)
		if m := openAt(t, k, index, beforeUpgrade.Add(time.Hour)).MigrateBindings(); m.Done || !slices.Equal(m.Bound, []string{"weather"}) {
			t.Fatalf("first migration = %+v", m)
		}
		lockable(t, k, dir, false)
		rewriteIndex(t, index, beforeUpgrade.Add(-time.Hour), movedDeepseek, weatherRecord)
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
		v := openAt(t, k, index, beforeUpgrade.Add(2*time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
			t.Fatalf("migration after the index changed = %+v", m)
		}
		assertRefused(t, v, dir, planted)
	})

	// Another keyd home, with an index of its own, shares the Keychain and its marker.
	t.Run("another home's index", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		storeLegacy(t, k, "deepseek", value)
		writeItem(t, dir, markerAccount, markerText(markerRunning, snapshotOf(legacyRecords)))
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
		v := openAt(t, k, writeIndex(t, beforeUpgrade.Add(-time.Hour), movedDeepseek), beforeUpgrade.Add(time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
			t.Fatalf("migration = %+v", m)
		}
		assertRefused(t, v, dir, planted)
	})

	t.Run("a marker that is not keyd's", func(t *testing.T) {
		for _, marker := range []string{"keyd-bindings:2:running:soon", "keyd-bindings:1:running:1760000000000000000"} {
			k, dir := fakeKeychain(t)
			writeItem(t, dir, markerAccount, marker)
			storeLegacy(t, k, "deepseek", value)
			planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
			v := openAt(t, k, writeIndex(t, beforeUpgrade, deepseekRecord), beforeUpgrade.Add(time.Hour))
			if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || m.Done {
				t.Fatalf("migration = %+v", m)
			}
			assertRefused(t, v, dir, planted)
			if readItem(t, dir, markerAccount) != marker {
				t.Fatal("the migration replaced a marker it could not read")
			}
		}
	})

	t.Run("a marker item whose access list is not keyd's", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		writeItem(t, dir, markerAccount, markerText(markerRunning, snapshotOf(legacyRecords)))
		storeLegacy(t, k, "deepseek", value)
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
		t.Setenv("FAKE_FOREIGN", markerAccount)
		v := openAt(t, k, writeIndex(t, beforeUpgrade, deepseekRecord), beforeUpgrade.Add(time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || m.Done {
			t.Fatalf("migration = %+v", m)
		}
		assertRefused(t, v, dir, planted)
	})

	// A marker removed once keyd has bound an item cannot start the migration over.
	t.Run("a marker removed after the migration bound an item", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		storeLegacy(t, k, "weather", longValue(40))
		index := writeIndex(t, beforeUpgrade, legacyRecords...)
		if m := openAt(t, k, index, beforeUpgrade.Add(time.Hour)).MigrateBindings(); !m.Done || len(m.Bound) != 1 {
			t.Fatalf("first migration = %+v", m)
		}
		if err := os.Remove(filepath.Join(dir, "store", "localdot-keyd-test."+markerAccount)); err != nil {
			t.Fatal(err)
		}
		storeLegacy(t, k, "deepseek", value)
		rewriteIndex(t, index, beforeUpgrade, movedDeepseek, weatherRecord)
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
		v := openAt(t, k, index, beforeUpgrade.Add(2*time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
			t.Fatalf("migration without its marker = %+v", m)
		}
		assertRefused(t, v, dir, planted)
	})
}

func assertRefused(t *testing.T, v *Vault, dir string, items map[string]string) {
	t.Helper()
	for account, data := range items {
		if readItem(t, dir, account) != data {
			t.Fatalf("the migration rewrote %s", account)
		}
	}
	got, err := v.Value("deepseek")
	var reentry *ReentryError
	if got != nil || !errors.As(err, &reentry) || reentry.ID != "deepseek" || v.Attention("deepseek") != Reenter {
		t.Fatalf("the unproven item reads %q, %v", got, err)
	}
}

// A finished migration never runs again: a later start writes nothing, and its values still read.
func TestMigrationRunsOnce(t *testing.T) {
	k, dir := fakeKeychain(t)
	storeLegacy(t, k, "deepseek", []byte("sk-legacy-deepseek-value"))
	storeLegacy(t, k, "weather", longValue(2000))
	index := writeIndex(t, beforeUpgrade, legacyRecords...)
	if m := openAt(t, k, index, beforeUpgrade.Add(time.Hour)).MigrateBindings(); !m.Done || len(m.Bound) != 2 {
		t.Fatalf("first migration = %+v", m)
	}
	items := map[string]string{}
	for _, name := range storeItems(dir) {
		account := strings.TrimPrefix(name, "localdot-keyd-test.")
		items[account] = readItem(t, dir, account)
	}
	for run := range 2 {
		clearLog(t, dir)
		v := openAt(t, k, index, beforeUpgrade.Add(time.Duration(run+2)*time.Hour))
		m := v.MigrateBindings()
		if len(m.Bound)+len(m.Reenter)+len(m.Rebound) != 0 || !m.Done {
			t.Fatalf("run %d = %+v", run+2, m)
		}
		if written := stores(t, dir); len(written) != 0 {
			t.Fatalf("run %d wrote %v", run+2, written)
		}
		for account, data := range items {
			if readItem(t, dir, account) != data {
				t.Fatalf("run %d changed %s", run+2, account)
			}
		}
		if _, err := v.Value("weather"); err != nil {
			t.Fatal(err)
		}
	}
	if state, _ := markerOf(t, dir); state != markerDone {
		t.Fatalf("marker %s", state)
	}
}

// A migration cut short, before an item, at an item's head write or after it, resumes on the next
// start with the records it began with, binds what is left with every value whole, and then finishes.
func TestMigrationCutShortResumes(t *testing.T) {
	lateFail := func(t *testing.T) (*Keychain, string) {
		k, dir := fakeKeychain(t)
		from := `printf '%s' "$pw" > "$item" ;;`
		if !strings.Contains(fakeSecurity, from) {
			t.Fatal("the fake has no store")
		}
		late := strings.Replace(fakeSecurity, from, `[ "$FAKE_FAIL" = "before:$acct" ] && return 1; printf '%s' "$pw" > "$item"; if [ "$FAKE_FAIL" = "after:$acct" ]; then return 1; fi ;;`, 1)
		if err := os.WriteFile(k.Path, []byte(late), 0o700); err != nil {
			t.Fatal(err)
		}
		return k, dir
	}
	values := map[string][]byte{"deepseek": []byte("sk-legacy-deepseek-value"), "weather": longValue(5000)}
	for _, cut := range []string{"before:weather", "after:weather", "before:deepseek", "after:" + markerAccount} {
		t.Run(cut, func(t *testing.T) {
			k, dir := lateFail(t)
			storeLegacy(t, k, "deepseek", values["deepseek"])
			storeLegacy(t, k, "weather", values["weather"])
			index := writeIndex(t, beforeUpgrade, legacyRecords...)
			t.Setenv("FAKE_FAIL", cut)
			if m := openAt(t, k, index, beforeUpgrade.Add(time.Hour)).MigrateBindings(); m.Done || len(m.Reenter) != 0 {
				t.Fatalf("cut migration = %+v", m)
			}
			if state, snapshot := markerOf(t, dir); state != markerRunning || !slices.Equal(snapshot, snapshotOf(legacyRecords)) {
				t.Fatalf("after the cut the marker is %s with %v", state, snapshot)
			}
			t.Setenv("FAKE_FAIL", "")
			v := openAt(t, k, index, beforeUpgrade.Add(2*time.Hour))
			if m := v.MigrateBindings(); !m.Done || len(m.Reenter) != 0 {
				t.Fatalf("resumed migration = %+v", m)
			}
			for id, value := range values {
				if got, err := v.Value(id); err != nil || !bytes.Equal(got, value) {
					t.Fatalf("%s after resuming: %d bytes, %v", id, len(got), err)
				}
			}
			if state, _ := markerOf(t, dir); state != markerDone {
				t.Fatalf("the finished marker is %s", state)
			}
		})
	}
}

// A start that cannot reach the Keychain leaves the migration as it was and lists nothing for
// re-entry: a locked Keychain is not a lost value.
func TestMigrationWaitsOutAnUnreadableKeychain(t *testing.T) {
	k, dir := fakeKeychain(t)
	storeLegacy(t, k, "deepseek", []byte("sk-legacy-deepseek-value"))
	locked := strings.Replace(fakeSecurity, `run "$@"`, `[ "$FAKE_FAIL" = locked ] && exit 1; run "$@"`, 1)
	if err := os.WriteFile(k.Path, []byte(locked), 0o700); err != nil {
		t.Fatal(err)
	}
	index := writeIndex(t, beforeUpgrade, deepseekRecord)
	t.Setenv("FAKE_FAIL", "locked")
	v := openAt(t, k, index, beforeUpgrade.Add(time.Hour))
	if m := v.MigrateBindings(); m.Done || len(m.Bound)+len(m.Reenter) != 0 || v.Attention("deepseek") != "" {
		t.Fatalf("migration over a locked Keychain = %+v", m)
	}
	if _, err := os.Stat(filepath.Join(dir, "store", "localdot-keyd-test."+markerAccount)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a migration that could not read the Keychain wrote its marker")
	}
	t.Setenv("FAKE_FAIL", "")
	if m := openAt(t, k, index, beforeUpgrade.Add(2*time.Hour)).MigrateBindings(); !m.Done || len(m.Bound) != 1 {
		t.Fatalf("migration once unlocked = %+v", m)
	}
}

// An item whose access list is not keyd's never becomes readable by waiting: the migration lists
// it for re-entry at once, instead of staying open for it, and storing the value again clears that.
func TestMigrationListsAnItemThatIsNotKeydsForReentry(t *testing.T) {
	for _, account := range []string{"deepseek", "deepseek.0"} {
		t.Run(account, func(t *testing.T) {
			k, _ := fakeKeychain(t)
			storeLegacy(t, k, "deepseek", []byte("sk-legacy-deepseek-value"))
			storeLegacy(t, k, "weather", longValue(40))
			t.Setenv("FAKE_FOREIGN", account)
			v := openAt(t, k, writeIndex(t, beforeUpgrade, legacyRecords...), beforeUpgrade.Add(time.Hour))
			if m := v.MigrateBindings(); !m.Done || !slices.Equal(m.Reenter, []string{"deepseek"}) || !slices.Equal(m.Bound, []string{"weather"}) {
				t.Fatalf("migration = %+v", m)
			}
			if _, err := v.Value("deepseek"); !errors.Is(err, ErrReenter) || v.Attention("deepseek") != Reenter {
				t.Fatalf("Value = %v", err)
			}
			t.Setenv("FAKE_FOREIGN", "")
			if err := v.Put(deepseekRecord, []byte("sk-entered-again-value")); err != nil || v.Attention("deepseek") != "" {
				t.Fatalf("Put = %v, attention %q", err, v.Attention("deepseek"))
			}
		})
	}
}

// A record whose value is gone is listed for re-entry. One whose value was stored for another
// destination is listed apart: its record was changed outside keyd. Storing the value again, or
// removing the key, clears either.
func TestAttentionClearsWhenTheValueIsStoredAgain(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", longValue(40), bindingOf(movedDeepseek)); err != nil {
		t.Fatal(err)
	}
	v := openAt(t, k, writeIndex(t, beforeUpgrade, legacyRecords...), beforeUpgrade.Add(time.Hour))
	if m := v.MigrateBindings(); !slices.Equal(m.Reenter, []string{"deepseek"}) || !slices.Equal(m.Rebound, []string{"weather"}) || !m.Done {
		t.Fatalf("migration = %+v", m)
	}
	if v.Attention("deepseek") != Reenter || v.Attention("weather") != Rebound {
		t.Fatalf("attention %q and %q", v.Attention("deepseek"), v.Attention("weather"))
	}
	if err := v.Put(deepseekRecord, []byte("sk-entered-again-value")); err != nil {
		t.Fatal(err)
	}
	if v.Attention("deepseek") != "" || v.Attention("weather") != Rebound {
		t.Fatal("storing one value again changed the wrong record")
	}
	if got, err := v.Value("deepseek"); err != nil || string(got) != "sk-entered-again-value" {
		t.Fatalf("Value = %q, %v", got, err)
	}
	if head := headOf(t, dir, "deepseek"); !strings.HasSuffix(head, ":"+bindingOf(deepseekRecord)) {
		t.Fatalf("deepseek holds %q", head)
	}
	if err := v.Delete("weather"); err != nil || v.Attention("weather") != "" {
		t.Fatalf("Delete = %v", err)
	}
}

// A value stored for another destination is refused as such at its first use: never as one to
// enter again, which would store the real key for the changed destination.
func TestValueTellsAReboundValueApart(t *testing.T) {
	k, _ := fakeKeychain(t)
	if err := k.Put("weather", longValue(40), bindingOf(movedDeepseek)); err != nil {
		t.Fatal(err)
	}
	v := openAt(t, k, writeIndex(t, beforeUpgrade, weatherRecord), beforeUpgrade)
	_, err := v.Value("weather")
	var rebound *ReboundError
	var reentry *ReentryError
	if !errors.As(err, &rebound) || rebound.ID != "weather" || errors.As(err, &reentry) || errors.Is(err, ErrReenter) ||
		v.Attention("weather") != Rebound {
		t.Fatalf("a rebound value: %v, attention %q", err, v.Attention("weather"))
	}
}

// A torn item found at its first use, after start, is listed for re-entry as well.
func TestValueMarksATornItemForReentry(t *testing.T) {
	k, dir := fakeKeychain(t)
	index := filepath.Join(t.TempDir(), "secrets.json")
	if err := openAt(t, k, index, beforeUpgrade).Put(weatherRecord, longValue(3000)); err != nil {
		t.Fatal(err)
	}
	writeItem(t, dir, "weather.1", strings.Repeat("0", 16)+":"+hex.EncodeToString([]byte("torn")))
	v := openAt(t, k, index, beforeUpgrade)
	if v.Attention("weather") != "" {
		t.Fatal("a value no one has read yet is listed for re-entry")
	}
	_, err := v.Value("weather")
	var reentry *ReentryError
	if !errors.As(err, &reentry) || !errors.Is(err, ErrReenter) || v.Attention("weather") != Reenter {
		t.Fatalf("a torn item: %v", err)
	}
}

// A secret may be named keyd-bindings, as before bindings: keyd's marker has an account no secret
// can take, so such a key is never read as the marker.
func TestASecretNamedLikeTheMarkerIsAnOrdinaryKey(t *testing.T) {
	k, dir := fakeKeychain(t)
	named := Record{ID: "keyd-bindings", Kind: KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}
	storeLegacy(t, k, "keyd-bindings", []byte("sk-legacy-named-value"))
	v := openAt(t, k, writeIndex(t, beforeUpgrade, named), beforeUpgrade.Add(time.Hour))
	if m := v.MigrateBindings(); !slices.Equal(m.Bound, []string{"keyd-bindings"}) || !m.Done {
		t.Fatalf("migration = %+v", m)
	}
	if got, err := v.Value("keyd-bindings"); err != nil || string(got) != "sk-legacy-named-value" {
		t.Fatalf("Value = %q, %v", got, err)
	}
	if err := v.Put(named, []byte("sk-stored-again-value")); err != nil {
		t.Fatal(err)
	}
	if state, _ := markerOf(t, dir); state != markerDone || !Writable("keyd-bindings") ||
		idPattern.MatchString(markerAccount) || idPattern.MatchString(sessionAccount) {
		t.Fatalf("marker %s", state)
	}
}
