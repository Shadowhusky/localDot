package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// The Keychain vault runs this executable as its item helper; under go test that is the test
// binary, which would otherwise run every test again in each helper it starts. Tests that start
// the test binary as keyd itself set KEYD_TEST_RUN.
func TestMain(m *testing.M) {
	if os.Getenv("KEYD_HELPER_PROBE") == "1" {
		os.Exit(helperProbe(os.Args[1:]))
	}
	if len(os.Args) > 1 && (os.Args[1] == "keychain-item" || os.Getenv("KEYD_TEST_RUN") == "1") {
		os.Exit(run(os.Args[1:], os.Stderr))
	}
	os.Exit(m.Run())
}

func TestPrivateKeychainCommandRejectsInvalidService(t *testing.T) {
	var diagnostic bytes.Buffer
	if code := run([]string{"keychain-item", "read", "foreign-service", "weather"}, &diagnostic); code != 45 {
		t.Fatalf("invalid private request returned %d", code)
	}
	if diagnostic.Len() != 0 {
		t.Fatal("private helper emitted diagnostics")
	}
}

func TestKeychainStartupRequiresSignedNativeHelper(t *testing.T) {
	home := t.TempDir()
	started := time.Now()
	want := "signed native keyd"
	if runtime.GOOS != "darwin" {
		want = "only on macOS"
	}
	if d, err := start(Config{Home: home, Vault: "keychain"}); err == nil || d != nil || !strings.Contains(err.Error(), want) {
		t.Fatalf("unsigned startup: daemon=%v, error=%v", d, err)
	}
	// The unsigned helper refuses at once; a check that runs out the helper's deadline ran
	// something other than the helper.
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("the unsigned helper took %v to refuse", elapsed)
	}
	if _, err := os.Lstat(filepath.Join(home, "keyd", "admin.sock")); !os.IsNotExist(err) {
		t.Fatal("unsigned keychain daemon exposed an admin socket")
	}
	lock, err := lockDir(filepath.Join(home, "keyd"))
	if err != nil {
		t.Fatal("failed startup kept the home lock")
	}
	lock.Close()
}
