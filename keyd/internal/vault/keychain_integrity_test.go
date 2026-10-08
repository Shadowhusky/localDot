package vault

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// failingFake is the fake tool with three more modes: FAKE_FAIL=add:<account> fails that one write,
// FAKE_FAIL=del:<account> that one delete, and FAKE_FAIL=del every delete.
func failingFake(t *testing.T) (*Keychain, string) {
	t.Helper()
	k, dir := fakeKeychain(t)
	s := fakeSecurity
	for from, to := range map[string]string{
		`if [ "$FAKE_FAIL" = add ]; then`:      `[ "$FAKE_FAIL" = "add:$acct" ] && return 1; if [ "$FAKE_FAIL" = add ]; then`,
		`delete) [ -f "$item" ] || return 44;`: `delete) [ "$FAKE_FAIL" = "del:$acct" ] && return 1; [ "$FAKE_FAIL" = del ] && return 1; [ -f "$item" ] || return 44;`,
	} {
		if !strings.Contains(s, from) {
			t.Fatalf("the fake has no %q", from)
		}
		s = strings.Replace(s, from, to, 1)
	}
	if err := os.WriteFile(k.Path, []byte(s), 0o700); err != nil {
		t.Fatal(err)
	}
	return k, dir
}

func storeItems(dir string) []string {
	entries, _ := os.ReadDir(filepath.Join(dir, "store"))
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// A tool that reports success but keeps the old items, as a failed update would: Put must notice
// on the read-back, and its error must carry neither value.
func TestKeychainRefusesAWriteThatDoesNotReadBack(t *testing.T) {
	k, _ := fakeKeychain(t)
	old, value := longValue(3000), longValue(maxValueLen)
	if err := k.Put("weather", old, testBinding); err != nil {
		t.Fatal(err)
	}
	stale := strings.Replace(fakeSecurity, `printf '%s' "$pw" > "$item"`, `[ -f "$item" ] || printf '%s' "$pw" > "$item"`, 1)
	if err := os.WriteFile(k.Path, []byte(stale), 0o700); err != nil {
		t.Fatal(err)
	}
	err := k.Put("weather", value, testBinding)
	if err == nil || carries(err.Error(), value) || carries(err.Error(), old) {
		t.Fatalf("Put through a tool that kept the old items: %v", err)
	}
}

// Spaces, quotes and backslashes travel on bounded stdin as hex, without shell parsing.
func TestKeychainKeepsEveryPrintableCharacter(t *testing.T) {
	k, _ := fakeKeychain(t)
	var value []byte
	for c := byte(' '); c <= '~'; c++ {
		value = append(value, c)
	}
	if err := k.Put("weather", value, testBinding); err != nil {
		t.Fatal(err)
	}
	if got, err := k.Get("weather", testBinding); err != nil || !bytes.Equal(got, value) {
		t.Fatalf("Get = %q, %v", got, err)
	}
}

func TestKeychainDeleteLeavesNoChunk(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", longValue(maxValueLen), testBinding); err != nil {
		t.Fatal(err)
	}
	if err := k.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if items, _ := os.ReadDir(filepath.Join(dir, "store")); len(items) != 0 {
		t.Fatalf("%d items outlived Delete", len(items))
	}
}

func TestKeychainAFailedPutLeavesNoFragment(t *testing.T) {
	for _, account := range []string{"weather.3", "weather"} {
		k, dir := failingFake(t)
		t.Setenv("FAKE_FAIL", "")
		if err := k.Put("weather", longValue(3000), testBinding); err != nil {
			t.Fatal(err)
		}
		value := longValue(maxValueLen)
		t.Setenv("FAKE_FAIL", "add:"+account)
		if err := k.Put("weather", value, testBinding); err == nil {
			t.Fatalf("Put succeeded with the write of %s failing", account)
		}
		for _, name := range storeItems(dir) {
			data, _ := os.ReadFile(filepath.Join(dir, "store", name))
			if carries(string(data), value) {
				t.Errorf("with the write of %s failing, %s kept part of the value", account, name)
			}
		}
	}
}

// Get never reads past the count the item names, so once the new value has read back whole, an old
// chunk the tool cannot remove is logged and the Put stands; the other old chunks still go.
func TestKeychainPutStandsOverAnOldChunkItCannotRemove(t *testing.T) {
	k, dir := failingFake(t)
	if err := k.Put("weather", longValue(maxValueLen), testBinding); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_FAIL", "del:weather.2")
	if err := k.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatalf("Put over an old chunk it cannot remove: %v", err)
	}
	if got, err := k.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	want := []string{"localdot-keyd-test.weather", "localdot-keyd-test.weather.0", "localdot-keyd-test.weather.2"}
	if items := storeItems(dir); !slices.Equal(items, want) {
		t.Fatalf("items %v, want %v", items, want)
	}
}

// Once the item is gone, a retried Delete must still report the chunk it cannot remove, or the
// vault drops the record and the chunk stays behind.
func TestKeychainDeleteReportsAChunkItCannotRemove(t *testing.T) {
	k, dir := failingFake(t)
	v, err := Open(k, filepath.Join(t.TempDir(), "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Put(httpRecord("weather"), longValue(3000)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_FAIL", "del:weather.1")
	for i := range 2 {
		if err := v.Delete("weather"); err == nil || errors.Is(err, ErrNotFound) {
			t.Fatalf("Delete %d with a chunk left behind: %v", i+1, err)
		}
	}
	if _, ok := v.Record("weather"); !ok {
		t.Fatalf("the record went while %v stayed", storeItems(dir))
	}
}

// Only valid IDs and values that Delete can remove whole may reach the item helper.
func TestKeychainPutRefusesWhatItCannotStoreSafely(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("victim", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"x\ndelete-generic-password -s localdot-keyd-test -a victim", "a b", "Weather", "weather.0", ""} {
		if err := k.Put(id, fakeValue, testBinding); err == nil {
			t.Errorf("Put of id %q succeeded", id)
		}
	}
	for _, value := range [][]byte{nil, longValue(maxValueLen + 1)} {
		if err := k.Put("weather", value, testBinding); err == nil {
			t.Errorf("Put of %d bytes succeeded", len(value))
		}
	}
	if got, err := k.Get("victim", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("the victim after the refused writes: %q, %v", got, err)
	}
	if items := storeItems(dir); len(items) != 2 {
		t.Fatalf("items %v, want only the victim's two", items)
	}
}

func headOf(t *testing.T, dir, id string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, "store", "localdot-keyd-test."+id))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// The item names the binding its value was stored for, and a read for any other binding is refused
// before a chunk is read.
func TestKeychainRefusesAValueStoredForAnotherBinding(t *testing.T) {
	k, dir := fakeKeychain(t)
	value := longValue(3000)
	if err := k.Put("weather", value, testBinding); err != nil {
		t.Fatal(err)
	}
	if head := headOf(t, dir, "weather"); !strings.HasSuffix(head, ":2:"+testBinding) || strings.Count(head, ":") != 3 {
		t.Fatalf("the item holds %q", head)
	}
	if err := os.Remove(filepath.Join(dir, "argv.log")); err != nil {
		t.Fatal(err)
	}
	other := bindingOf(Record{ID: "weather", Kind: KindHTTP, Hosts: []string{"attacker.example.test"}, Header: "X-Api-Key", Format: "raw"})
	got, err := k.Get("weather", other)
	if !errors.Is(err, errRebound) || got != nil || carries(err.Error(), value) {
		t.Fatalf("Get for another binding = %q, %v", got, err)
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if string(argv) != "keychain-item read localdot-keyd-test weather\n" {
		t.Fatalf("the refused read ran %q", argv)
	}
	for _, binding := range []string{"", "weather", strings.ToUpper(testBinding), testBinding + "0", testBinding[1:] + ":"} {
		if err := k.Put("weather", fakeValue, binding); !errors.Is(err, errUnchanged) {
			t.Errorf("Put with the binding %q: %v", binding, err)
		}
		if _, err := k.Get("weather", binding); err == nil {
			t.Errorf("Get with the binding %q succeeded", binding)
		}
	}
	if got, err := k.Get("weather", testBinding); err != nil || !bytes.Equal(got, value) {
		t.Fatalf("Get after the refused writes: %d bytes, %v", len(got), err)
	}
}

// An item written before keyd stored bindings has none to check: whichever keyd read it first would
// choose it. Such an item, like one whose head is malformed, is refused from its head alone and left
// as it is, until the value is stored again.
func TestKeychainRefusesAnItemStoredWithoutItsBinding(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	head := filepath.Join(dir, "store", "localdot-keyd-test.weather")
	legacy := strings.TrimSuffix(headOf(t, dir, "weather"), ":"+testBinding)
	heads := map[string]string{
		"no binding":    legacy,
		"empty binding": legacy + ":",
		"not hex":       legacy + ":" + strings.Repeat("z", 64),
		"a fifth field": legacy + ":" + testBinding + ":" + testBinding,
	}
	for name, h := range heads {
		if err := os.WriteFile(head, []byte(h), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Remove(filepath.Join(dir, "argv.log")); err != nil {
			t.Fatal(err)
		}
		if got, err := k.Get("weather", testBinding); err == nil || got != nil || carries(err.Error(), fakeValue) {
			t.Errorf("%s: Get = %q, %v", name, got, err)
		}
		if argv, _ := os.ReadFile(filepath.Join(dir, "argv.log")); string(argv) != "keychain-item read localdot-keyd-test weather\n" {
			t.Errorf("%s: the refused read ran %q", name, argv)
		}
		if got := headOf(t, dir, "weather"); got != h {
			t.Errorf("%s: the refused read left the item holding %q", name, got)
		}
	}
	if err := k.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	if got, err := k.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("after storing it again Get = %q, %v", got, err)
	}
}
