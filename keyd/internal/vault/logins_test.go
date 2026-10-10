package vault

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoginsPersistPrivatelyAndBindExactOrigin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	creds := &machineCreds{key: 0x5a, tpm: true}
	store := fastFileVault(t, path, creds)
	l := NewLogins(store)
	want := Login{Username: "fixture-user", Password: "pässword 密碼 with spaces"}
	if err := l.Put("https://github.com", want); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), want.Username) || strings.Contains(string(raw), want.Password) {
		t.Fatal("credentials leaked to disk")
	}
	again := NewLogins(fastFileVault(t, path, creds))
	got, err := again.Get("https://github.com")
	if err != nil || got != want {
		t.Fatal("saved login did not survive reopening")
	}
	for _, origin := range []string{"https://github.com.evil.test", "https://sub.github.com", "https://github.com:8443"} {
		if _, err := again.Get(origin); !errors.Is(err, ErrNotFound) {
			t.Fatal("login crossed origin")
		}
	}
	if err := again.Delete("https://github.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := again.Get("https://github.com"); !errors.Is(err, ErrNotFound) {
		t.Fatal("login survived removal")
	}
}
func TestLoginsRejectUnsafeOriginsAndReserveNamespace(t *testing.T) {
	l := NewLogins(NewMemory())
	for _, origin := range []string{"http://github.com", "https://u:p@github.com", "https://github.com/path", "https://github.com?x=1", "https://github.com#x"} {
		if err := l.Put(origin, Login{Password: "fixture"}); err == nil {
			t.Fatal("invalid origin accepted")
		}
	}
	id, _, _ := loginIdentity("https://github.com")
	if Writable(id) {
		t.Fatal("API key can overwrite credential namespace")
	}
}
