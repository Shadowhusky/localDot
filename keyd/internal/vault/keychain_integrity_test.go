package vault

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
