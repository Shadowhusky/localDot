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

// writeIndex writes the index an earlier keyd left, each record timed as of at.
func writeIndex(t *testing.T, at time.Time, records ...Record) string {
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
	path := filepath.Join(t.TempDir(), "secrets.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
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

func markerOf(t *testing.T, dir string) (string, time.Time) {
	t.Helper()
	state, began, ok := parseMarker(readItem(t, dir, BindingsMarkerID))
	if !ok {
		t.Fatalf("the marker holds %q", readItem(t, dir, BindingsMarkerID))
	}
	return state, began
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

// A value a keyd from before bindings stored, under a record the index held before the upgrade, is
// bound to that record by rewriting its head alone; the migration is then recorded as done.
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
	now := beforeUpgrade.Add(time.Hour)
	v := openAt(t, k, writeIndex(t, beforeUpgrade, legacyRecords...), now)
	m := v.MigrateBindings()
	if !slices.Equal(m.Bound, []string{"deepseek", "weather"}) || len(m.Reenter) != 0 || !m.Done {
		t.Fatalf("migration = %+v", m)
	}
	for i, rec := range legacyRecords {
		value := [][]byte{short, long}[i]
		if got, err := v.Value(rec.ID); err != nil || !bytes.Equal(got, value) || v.NeedsReentry(rec.ID) {
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
	if state, began := markerOf(t, dir); state != markerDone || !began.Equal(now) {
		t.Fatalf("marker %s from %v", state, began)
	}
}

// An unbound item keyd cannot prove it wrote stays refused, untouched, and is listed for re-entry:
// one planted after the migration finished, one under a record the index gained after the migration
// began, one under a marker that is not keyd's, and every item laid out other than as keyd lays one.
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

	t.Run("a record from after the migration began", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		began := beforeUpgrade.Add(time.Hour)
		writeItem(t, dir, BindingsMarkerID, markerText(markerRunning, began))
		storeLegacy(t, k, "deepseek", value)
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
		v := openAt(t, k, writeIndex(t, began.Add(time.Second), deepseekRecord), began.Add(time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || !m.Done {
			t.Fatalf("migration = %+v", m)
		}
		assertRefused(t, v, dir, planted)
	})

	t.Run("a marker that is not keyd's", func(t *testing.T) {
		k, dir := fakeKeychain(t)
		writeItem(t, dir, BindingsMarkerID, "keyd-bindings:1:running:soon")
		storeLegacy(t, k, "deepseek", value)
		planted := map[string]string{"deepseek": readItem(t, dir, "deepseek")}
		v := openAt(t, k, writeIndex(t, beforeUpgrade, deepseekRecord), beforeUpgrade.Add(time.Hour))
		if m := v.MigrateBindings(); len(m.Bound) != 0 || !slices.Equal(m.Reenter, []string{"deepseek"}) || m.Done {
			t.Fatalf("migration = %+v", m)
		}
		assertRefused(t, v, dir, planted)
		if readItem(t, dir, BindingsMarkerID) != "keyd-bindings:1:running:soon" {
			t.Fatal("the migration replaced a marker it could not read")
		}
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
	if got != nil || !errors.As(err, &reentry) || reentry.ID != "deepseek" || !v.NeedsReentry("deepseek") {
		t.Fatalf("the unproven item reads %q, %v", got, err)
	}
}

// A finished migration never runs again: a later start writes nothing, and its values still read.
func TestMigrationRunsOnce(t *testing.T) {
	k, dir := fakeKeychain(t)
	storeLegacy(t, k, "deepseek", []byte("sk-legacy-deepseek-value"))
	storeLegacy(t, k, "weather", longValue(2000))
	index := writeIndex(t, beforeUpgrade, legacyRecords...)
	now := beforeUpgrade.Add(time.Hour)
	if m := openAt(t, k, index, now).MigrateBindings(); !m.Done || len(m.Bound) != 2 {
		t.Fatalf("first migration = %+v", m)
	}
	items := map[string]string{}
	for _, name := range storeItems(dir) {
		account := strings.TrimPrefix(name, "localdot-keyd-test.")
		items[account] = readItem(t, dir, account)
	}
	for run := range 2 {
		clearLog(t, dir)
		v := openAt(t, k, index, now.Add(time.Duration(run+1)*time.Hour))
		m := v.MigrateBindings()
		if len(m.Bound) != 0 || len(m.Reenter) != 0 || !m.Done {
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
	if state, began := markerOf(t, dir); state != markerDone || !began.Equal(now) {
		t.Fatalf("marker %s from %v", state, began)
	}
}

// A migration cut short, before an item, at an item's head write or after it, resumes on the next
// start from the moment it began, binds what is left with every value whole, and then finishes.
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
	for _, cut := range []string{"before:weather", "after:weather", "before:deepseek", "after:" + BindingsMarkerID} {
		t.Run(cut, func(t *testing.T) {
			k, dir := lateFail(t)
			storeLegacy(t, k, "deepseek", values["deepseek"])
			storeLegacy(t, k, "weather", values["weather"])
			index := writeIndex(t, beforeUpgrade, legacyRecords...)
			began := beforeUpgrade.Add(time.Hour)
			t.Setenv("FAKE_FAIL", cut)
			if m := openAt(t, k, index, began).MigrateBindings(); m.Done || len(m.Reenter) != 0 {
				t.Fatalf("cut migration = %+v", m)
			}
			if state, at := markerOf(t, dir); state != markerRunning || !at.Equal(began) {
				t.Fatalf("after the cut the marker is %s from %v", state, at)
			}
			t.Setenv("FAKE_FAIL", "")
			v := openAt(t, k, index, began.Add(time.Hour))
			if m := v.MigrateBindings(); !m.Done || len(m.Reenter) != 0 {
				t.Fatalf("resumed migration = %+v", m)
			}
			for id, value := range values {
				if got, err := v.Value(id); err != nil || !bytes.Equal(got, value) {
					t.Fatalf("%s after resuming: %d bytes, %v", id, len(got), err)
				}
			}
			if state, at := markerOf(t, dir); state != markerDone || !at.Equal(began) {
				t.Fatalf("the finished marker is %s from %v", state, at)
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
	if m := v.MigrateBindings(); m.Done || len(m.Bound)+len(m.Reenter) != 0 || v.NeedsReentry("deepseek") {
		t.Fatalf("migration over a locked Keychain = %+v", m)
	}
	if _, err := os.Stat(filepath.Join(dir, "store", "localdot-keyd-test."+BindingsMarkerID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a migration that could not read the Keychain wrote its marker")
	}
	t.Setenv("FAKE_FAIL", "")
	if m := openAt(t, k, index, beforeUpgrade.Add(2*time.Hour)).MigrateBindings(); !m.Done || len(m.Bound) != 1 {
		t.Fatalf("migration once unlocked = %+v", m)
	}
}

// A record whose value is gone, or whose value was stored for another binding, is listed for
// re-entry; storing the value again clears that.
func TestReentryClearsWhenTheValueIsStoredAgain(t *testing.T) {
	k, dir := fakeKeychain(t)
	other := Record{ID: "weather", Kind: KindHTTP, Hosts: []string{"elsewhere.example.test"}, Header: "Authorization", Format: "bearer"}
	if err := k.Put("weather", longValue(40), bindingOf(other)); err != nil {
		t.Fatal(err)
	}
	v := openAt(t, k, writeIndex(t, beforeUpgrade, legacyRecords...), beforeUpgrade.Add(time.Hour))
	if m := v.MigrateBindings(); !slices.Equal(m.Reenter, []string{"deepseek", "weather"}) || !m.Done {
		t.Fatalf("migration = %+v", m)
	}
	if err := v.Put(deepseekRecord, []byte("sk-entered-again-value")); err != nil {
		t.Fatal(err)
	}
	if v.NeedsReentry("deepseek") || !v.NeedsReentry("weather") {
		t.Fatal("storing one value again changed the wrong record")
	}
	if got, err := v.Value("deepseek"); err != nil || string(got) != "sk-entered-again-value" {
		t.Fatalf("Value = %q, %v", got, err)
	}
	if head := headOf(t, dir, "deepseek"); !strings.HasSuffix(head, ":"+bindingOf(deepseekRecord)) {
		t.Fatalf("deepseek holds %q", head)
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
	if v.NeedsReentry("weather") {
		t.Fatal("a value no one has read yet is listed for re-entry")
	}
	_, err := v.Value("weather")
	var reentry *ReentryError
	if !errors.As(err, &reentry) || !errors.Is(err, ErrReenter) || !v.NeedsReentry("weather") {
		t.Fatalf("a torn item: %v", err)
	}
}
