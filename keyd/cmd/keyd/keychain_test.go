package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
	if d, err := start(Config{Home: home, Vault: "keychain"}); err == nil || d != nil || !strings.Contains(err.Error(), "signed native keyd") {
		t.Fatalf("unsigned startup: daemon=%v, error=%v", d, err)
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
