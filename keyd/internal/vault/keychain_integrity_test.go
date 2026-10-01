package vault

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// failingFake is the fake tool with two more modes: FAKE_FAIL=add:<account> fails that one write,
// and FAKE_FAIL=del:<account> that one delete.
func failingFake(t *testing.T) (*Keychain, string) {
	t.Helper()
	k, dir := fakeKeychain(t)
	s := fakeSecurity
	for from, to := range map[string]string{
		`if [ "$FAKE_FAIL" = add ]; then`:                       `[ "$FAKE_FAIL" = "add:$acct" ] && return 1; if [ "$FAKE_FAIL" = add ]; then`,
		`delete-generic-password) [ -f "$item" ] || return 44;`: `delete-generic-password) [ "$FAKE_FAIL" = "del:$acct" ] && return 1; [ -f "$item" ] || return 44;`,
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
	if err := k.Put("weather", old); err != nil {
		t.Fatal(err)
	}
	stale := strings.Replace(fakeSecurity, `printf '%s' "$pw" > "$item"`, `[ -f "$item" ] || printf '%s' "$pw" > "$item"`, 1)
	if err := os.WriteFile(k.Path, []byte(stale), 0o700); err != nil {
		t.Fatal(err)
	}
	err := k.Put("weather", value)
	if err == nil || carries(err.Error(), value) || carries(err.Error(), old) {
		t.Fatalf("Put through a tool that kept the old items: %v", err)
	}
}

// Spaces, quotes and backslashes reach security -i only as hex, so its parser never splits a value.
func TestKeychainKeepsEveryPrintableCharacter(t *testing.T) {
	k, _ := fakeKeychain(t)
	var value []byte
	for c := byte(' '); c <= '~'; c++ {
		value = append(value, c)
	}
	if err := k.Put("weather", value); err != nil {
		t.Fatal(err)
	}
	if got, err := k.Get("weather"); err != nil || !bytes.Equal(got, value) {
		t.Fatalf("Get = %q, %v", got, err)
	}
}

func TestKeychainDeleteLeavesNoChunk(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", longValue(maxValueLen)); err != nil {
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
		if err := k.Put("weather", longValue(3000)); err != nil {
			t.Fatal(err)
		}
		value := longValue(maxValueLen)
		t.Setenv("FAKE_FAIL", "add:"+account)
		if err := k.Put("weather", value); err == nil {
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

func TestKeychainPutReportsAnOldChunkItCannotRemove(t *testing.T) {
	k, _ := failingFake(t)
	if err := k.Put("weather", longValue(maxValueLen)); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_FAIL", "del:weather.5")
	if err := k.Put("weather", fakeValue); err == nil {
		t.Fatal("Put succeeded with a chunk of the old value left behind")
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

// An id reaches the security -i line as text, so only a valid one may; and only a value Delete can
// remove whole.
func TestKeychainPutRefusesWhatItCannotStoreSafely(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("victim", fakeValue); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"x\ndelete-generic-password -s localdot-keyd-test -a victim", "a b", "Weather", "weather.0", ""} {
		if err := k.Put(id, fakeValue); err == nil {
			t.Errorf("Put of id %q succeeded", id)
		}
	}
	for _, value := range [][]byte{nil, longValue(maxValueLen + 1)} {
		if err := k.Put("weather", value); err == nil {
			t.Errorf("Put of %d bytes succeeded", len(value))
		}
	}
	if got, err := k.Get("victim"); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("the victim after the refused writes: %q, %v", got, err)
	}
	if items := storeItems(dir); len(items) != 2 {
		t.Fatalf("items %v, want only the victim's two", items)
	}
}
