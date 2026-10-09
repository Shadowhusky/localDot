package vault

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeSecurity mimics keyd's private item helper protocol, keeping fake items as files.
// FAKE_FAIL=add makes every add fail after printing what it was given; FAKE_FOREIGN names an item
// whose access list is not keyd's.
const fakeSecurity = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/argv.log"
store="$FAKE_DIR/store"
mkdir -p "$store"
run() {
  [ "$1" = keychain-item ] || return 45
  cmd=$2 svc=$3 acct=$4 pw=
  [ "$cmd" != store ] || pw=$(cat)
  item="$store/$svc.$acct"
  case "$cmd" in
    store)
      if [ "$FAKE_FAIL" = add ]; then echo "item helper: cannot store $pw" >&2; return 45; fi
      printf '%s' "$pw" > "$item" ;;
    read)
      [ -f "$item" ] || return 44
      [ "$FAKE_FOREIGN" != "$acct" ] || return 46
      cat "$item" ;;
    delete) [ -f "$item" ] || return 44; rm "$item" ;;
    *) echo "security: unknown command \"$cmd\"" >&2; return 1 ;;
  esac
}
run "$@"
`

func fakeKeychain(t *testing.T) (*Keychain, string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "security")
	if err := os.WriteFile(bin, []byte(fakeSecurity), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_DIR", dir)
	return &Keychain{Service: "localdot-keyd-test", Path: bin, configureCommand: func(cmd *exec.Cmd) {
		cmd.Env = append(cmd.Env, "FAKE_DIR="+dir, "FAKE_FAIL="+os.Getenv("FAKE_FAIL"), "FAKE_FOREIGN="+os.Getenv("FAKE_FOREIGN"))
	}}, dir
}

// longValue is a fake printable value of n bytes.
func longValue(n int) []byte {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.+/="
	rng := rand.New(rand.NewPCG(7, uint64(n)))
	out := make([]byte, n)
	for i := range out {
		out[i] = chars[rng.IntN(len(chars))]
	}
	return out
}

// carries reports whether text holds any 8 bytes of value or any 16 characters of its hex.
func carries(text string, value []byte) bool {
	h := hex.EncodeToString(value)
	for i := 0; i+8 <= len(value); i++ {
		if strings.Contains(text, string(value[i:i+8])) {
			return true
		}
	}
	for i := 0; i+16 <= len(h); i++ {
		if strings.Contains(text, h[i:i+16]) {
			return true
		}
	}
	return false
}

func TestKeychainRoundTripThroughTheItemHelper(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	got, err := k.Get("weather", testBinding)
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if err := k.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather", testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	if err := k.Delete("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete twice: %v", err)
	}
	argv, err := os.ReadFile(filepath.Join(dir, "argv.log"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(argv, fakeValue) || bytes.Contains(argv, []byte(hex.EncodeToString(fakeValue))) {
		t.Fatalf("the secret reached the command line: %s", argv)
	}
}

func TestKeychainKeepsLongValuesWhole(t *testing.T) {
	k, dir := fakeKeychain(t)
	for _, n := range []int{3000, maxValueLen} {
		value := longValue(n)
		if err := k.Put("weather", value, testBinding); err != nil {
			t.Fatalf("Put of %d bytes: %v", n, err)
		}
		if got, err := k.Get("weather", testBinding); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", n, len(got), err)
		}
	}
	if err := k.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	items, _ := os.ReadDir(filepath.Join(dir, "store"))
	if len(items) != 2 {
		t.Fatalf("%d items after a short value replaced a long one, want the item and one chunk", len(items))
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if carries(string(argv), longValue(maxValueLen)) {
		t.Fatalf("the secret reached the command line: %s", argv)
	}
}

func TestKeychainErrorsNeverCarryTheValue(t *testing.T) {
	k, dir := fakeKeychain(t)
	value := longValue(maxValueLen)
	t.Setenv("FAKE_FAIL", "add")
	if err := k.Put("weather", value, testBinding); err == nil || carries(err.Error(), value) {
		t.Fatalf("Put through a failing tool: %v", err)
	}
	t.Setenv("FAKE_FAIL", "")
	if err := k.Put("weather", value, testBinding); err != nil {
		t.Fatal(err)
	}
	// A chunk from another write: what a crash between two chunk writes leaves.
	chunk := filepath.Join(dir, "store", "localdot-keyd-test.weather.1")
	data, err := os.ReadFile(chunk)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(chunk, append([]byte(strings.Repeat("0", 16)), data[16:]...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather", testBinding); err == nil || carries(err.Error(), value) {
		t.Fatalf("Get of a torn value: %v", err)
	}
}

func TestKeychainReportsToolFailures(t *testing.T) {
	k := &Keychain{Service: "localdot-keyd-test", Path: filepath.Join(t.TempDir(), "missing")}
	if err := k.Put("weather", fakeValue, testBinding); err == nil {
		t.Fatal("Put through a missing tool succeeded")
	}
	if _, err := k.Get("weather", testBinding); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Get through a missing tool: %v", err)
	}
}

// Opt-in only in a Developer ID signed test executable (same keyd identifier, hardened runtime).
// Writes/deletes only unique fake items in the explicit test service; never run implicitly.
func TestKeychainAgainstTheLoginKeychain(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("KEYD_KEYCHAIN_TEST") != "1" {
		t.Skip("set KEYD_KEYCHAIN_TEST=1 on macOS to use the login keychain")
	}
	k := NewKeychain("localdot-keyd-test")
	k.configureCommand = func(cmd *exec.Cmd) { cmd.Stderr = os.Stderr }
	id := fmt.Sprintf("probe-%d", time.Now().UnixNano())
	t.Logf("synthetic Keychain account: %s (service localdot-keyd-test)", id)
	t.Cleanup(func() { _ = k.Delete(id) })
	for _, value := range [][]byte{fakeValue, longValue(maxValueLen), []byte("second-fake-value-for-test")} {
		if err := k.Put(id, value, testBinding); err != nil {
			t.Fatalf("Put of %d bytes: %v", len(value), err)
		}
		if got, err := k.Get(id, testBinding); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", len(value), len(got), err)
		}
	}
	if err := k.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get(id, testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	for i := range maxChunks {
		if _, err := k.find(context.Background(), chunkAccount(id, i)); !errors.Is(err, ErrNotFound) {
			t.Fatal("a test chunk outlived Delete")
		}
	}
}

// A release update changes the executable path and code hash. Use a separately signed keyd
// binary to prove the stored ACL permits that transition and a subsequent rollback. The test
// runner must itself be signed; the production helper still checks both identities normally.
func TestKeychainSurvivesSignedExecutableUpdate(t *testing.T) {
	path := os.Getenv("KEYD_KEYCHAIN_UPDATE_BIN")
	if runtime.GOOS != "darwin" || os.Getenv("KEYD_KEYCHAIN_TEST") != "1" || path == "" {
		t.Skip("requires signed test runner and an explicit signed update binary")
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		t.Fatal("update binary must have a canonical absolute path")
	}
	before := NewKeychain("localdot-keyd-test")
	after := NewKeychain("localdot-keyd-test")
	after.Path = path
	if path == before.Path {
		t.Fatal("update must use a different signed executable")
	}
	for _, k := range []*Keychain{before, after} {
		k.configureCommand = func(cmd *exec.Cmd) { cmd.Stderr = os.Stderr }
		if err := k.Check(); err != nil {
			t.Fatal(err)
		}
	}
	id := fmt.Sprintf("probe-%d", time.Now().UnixNano())
	t.Logf("synthetic update account: %s (service localdot-keyd-test)", id)
	t.Cleanup(func() { _ = before.Delete(id); _ = after.Delete(id) })
	if err := before.Put(id, fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	if got, err := after.Get(id, testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("updated binary could not read existing fake value: %v", err)
	}
	updated := []byte("updated-fake-value-for-signed-release")
	if err := after.Put(id, updated, testBinding); err != nil {
		t.Fatal(err)
	}
	if got, err := before.Get(id, testBinding); err != nil || !bytes.Equal(got, updated) {
		t.Fatalf("rollback binary could not read updated fake value: %v", err)
	}
	if err := before.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := after.Get(id, testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("updated binary did not observe deletion: %v", err)
	}
	for i := range maxChunks {
		if _, err := after.find(context.Background(), chunkAccount(id, i)); !errors.Is(err, ErrNotFound) {
			t.Fatal("a synthetic update chunk outlived Delete")
		}
	}
}
