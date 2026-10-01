package vault

import (
	"bytes"
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

// fakeSecurity mimics the /usr/bin/security calls Keychain makes, keeping items as files. Like the
// real tool, security -i runs the first 4,095 characters of a line as one command and the rest as
// another, names an unknown command in its error, and exits with the last command's status.
// FAKE_FAIL=add makes every add fail after printing what it was given.
const fakeSecurity = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/argv.log"
store="$FAKE_DIR/store"
mkdir -p "$store"
run() {
  cmd=$1
  shift
  svc= acct= pw=
  while [ $# -gt 0 ]; do
    case "$1" in
      -s) svc=$2; shift 2 ;;
      -a) acct=$2; shift 2 ;;
      -w) if [ $# -ge 2 ]; then pw=$2; shift 2; else shift; fi ;;
      -l) shift 2 ;;
      *) shift ;;
    esac
  done
  item="$store/$svc.$acct"
  case "$cmd" in
    add-generic-password)
      if [ "$FAKE_FAIL" = add ]; then echo "add-generic-password: cannot store $pw" >&2; return 1; fi
      printf '%s' "$pw" > "$item" ;;
    find-generic-password) [ -f "$item" ] || return 44; cat "$item"; echo ;;
    delete-generic-password) [ -f "$item" ] || return 44; rm "$item" ;;
    *) echo "security: unknown command \"$cmd\"" >&2; return 1 ;;
  esac
}
if [ "$1" = "-i" ]; then
  fold -w 4095 | {
    status=0
    while IFS= read -r piece; do
      run $piece
      status=$?
    done
    exit $status
  }
  exit $?
fi
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
	return &Keychain{Service: "localdot-keyd-test", Path: bin}, dir
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

func TestKeychainRoundTripThroughTheSecurityTool(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", fakeValue); err != nil {
		t.Fatal(err)
	}
	got, err := k.Get("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if err := k.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather"); !errors.Is(err, ErrNotFound) {
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
		if err := k.Put("weather", value); err != nil {
			t.Fatalf("Put of %d bytes: %v", n, err)
		}
		if got, err := k.Get("weather"); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", n, len(got), err)
		}
	}
	if err := k.Put("weather", fakeValue); err != nil {
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
	if err := k.Put("weather", value); err == nil || carries(err.Error(), value) {
		t.Fatalf("Put through a failing tool: %v", err)
	}
	t.Setenv("FAKE_FAIL", "")
	if err := k.Put("weather", value); err != nil {
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
	if _, err := k.Get("weather"); err == nil || carries(err.Error(), value) {
		t.Fatalf("Get of a torn value: %v", err)
	}
}

func TestKeychainReportsToolFailures(t *testing.T) {
	k := &Keychain{Service: "localdot-keyd-test", Path: filepath.Join(t.TempDir(), "missing")}
	if err := k.Put("weather", fakeValue); err == nil {
		t.Fatal("Put through a missing tool succeeded")
	}
	if _, err := k.Get("weather"); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Get through a missing tool: %v", err)
	}
}

// Opt-in: writes and deletes fake items in the login keychain, the longest value included.
func TestKeychainAgainstTheLoginKeychain(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("KEYD_KEYCHAIN_TEST") != "1" {
		t.Skip("set KEYD_KEYCHAIN_TEST=1 on macOS to use the login keychain")
	}
	k := NewKeychain("localdot-keyd-test")
	id := fmt.Sprintf("probe-%d", time.Now().UnixNano())
	t.Cleanup(func() { _ = k.Delete(id) })
	for _, value := range [][]byte{fakeValue, longValue(maxValueLen), []byte("second-fake-value-for-test")} {
		if err := k.Put(id, value); err != nil {
			t.Fatalf("Put of %d bytes: %v", len(value), err)
		}
		if got, err := k.Get(id); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", len(value), len(got), err)
		}
	}
	if err := k.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	if exec.Command(k.Path, "find-generic-password", "-s", k.Service).Run() == nil {
		t.Fatal("an item of the test service outlived Delete")
	}
}
