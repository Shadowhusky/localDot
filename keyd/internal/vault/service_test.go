package vault

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestEachDotHasItsOwnService(t *testing.T) {
	for service, want := range map[string]bool{
		"localdot-keyd":                           true,
		"localdot-keyd.work":                      true,
		"localdot-keyd.a":                         true,
		"localdot-keyd.w0rk-2":                    true,
		"localdot-keyd.abcdefghijklmnopqrstuvwx":  true,
		"localdot-keyd.abcdefghijklmnopqrstuvwxy": false,
		"localdot-keyd.":                          false,
		"localdot-keyd.Work":                      false,
		"localdot-keyd.1work":                     false,
		"localdot-keyd.work.x":                    false,
		"localdot-keyd.work ":                     false,
		"localdot-keydx":                          false,
		"localdot-keyd-work":                      false,
		"other":                                   false,
		"":                                        false,
		"localdot-keyd-test":                      false,
		"localdot-keyd.work\n":                    false,
		"localdot-keyd.wörk":                      false,
	} {
		if DotService(service) != want {
			t.Errorf("DotService(%q) = %v, want %v", service, !want, want)
		}
		if ValidService(service) != (want || service == testService) {
			t.Errorf("ValidService(%q) disagrees", service)
		}
	}
	if !ValidService(testService) {
		t.Fatal("the tests' own service is refused")
	}
}

func TestItemHelperServesEachDotsService(t *testing.T) {
	for _, test := range []struct {
		op, service, account string
		want                 bool
	}{
		{"read", "localdot-keyd.work", "weather", true},
		{"store", "localdot-keyd.work", "weather.0", true},
		{"list", "localdot-keyd.work", "_all", true},
		{"claim", "localdot-keyd.work", "_session", true},
		{"read", "localdot-keyd.Work", "weather", false},
		{"read", "localdot-keyd.", "weather", false},
		{"read", "localdot-keydx", "weather", false},
		{"delete", "localdot-keyd.work", "_session", true},
		{"delete", "localdot-keyd", "_bindings", true},
		{"read", "localdot-keyd.work", "_session", false},
		{"store", "localdot-keyd.work", "_session", false},
		{"delete", "localdot-keyd.work", "_all", false},
	} {
		if got := validRequest(test.op, test.service, test.account); got != test.want {
			t.Errorf("validRequest(%s, %s, %s) = %v", test.op, test.service, test.account, got)
		}
	}
}

func TestAnotherDotsKeychainItemsKeepTheirOwnService(t *testing.T) {
	k, dir := fakeKeychain(t)
	k.Service = "localdot-keyd.work"
	if err := k.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	if got, err := k.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "store", "localdot-keyd.work.weather")); err != nil {
		t.Fatal("the item was not kept under the dot's service")
	}
	k.Service = "localdot-keyd.Work"
	if _, err := k.Get("weather", testBinding); err == nil {
		t.Fatal("an invalid service reached the helper")
	}
}

func TestAnotherDotsKeyringItemsKeepTheirOwnService(t *testing.T) {
	s, dir := fakeSecretService(t)
	s.Service = "localdot-keyd.work"
	if err := s.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	if got, err := s.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if !strings.Contains(string(argv), "service localdot-keyd.work account weather") {
		t.Fatalf("argv = %s", argv)
	}
	s.Service = "localdot-keyd.Work"
	if err := s.Put("weather", fakeValue, testBinding); err == nil {
		t.Fatal("an invalid service was stored")
	}
}

func TestEachDotsVaultKeyHasItsOwnCredentialName(t *testing.T) {
	if credentialName("") != "localdot-keyd-vault" || credentialName(DefaultService) != "localdot-keyd-vault" {
		t.Fatal("the first dot's credential name changed")
	}
	if credentialName("localdot-keyd.work") != "localdot-keyd.work-vault" {
		t.Fatalf("credential name = %q", credentialName("localdot-keyd.work"))
	}
	dir := t.TempDir()
	bin := filepath.Join(dir, "systemd-creds")
	if err := os.WriteFile(bin, []byte(fakeSystemdCreds), 0o700); err != nil {
		t.Fatal(err)
	}
	creds := func(service string) *SystemdCreds {
		return &SystemdCreds{user: true, service: service, tool: tool{path: bin, env: []string{"PATH=/usr/bin:/bin"}, configureCommand: func(cmd *exec.Cmd) {
			cmd.Env = append(cmd.Env, "FAKE_DIR="+dir)
		}}}
	}
	work, main := creds("localdot-keyd.work"), creds(DefaultService)
	sealed, err := work.Encrypt([]byte("vault key"))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := work.Decrypt(sealed); err != nil || string(got) != "vault key" {
		t.Fatalf("Decrypt = %q, %v", got, err)
	}
	if _, err := main.Decrypt(sealed); err == nil {
		t.Fatal("one dot's vault key unwrapped as another's")
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if !strings.Contains(string(argv), "encrypt --name=localdot-keyd.work-vault --user - -") {
		t.Fatalf("argv = %s", argv)
	}
}

func TestLoginsListTheOriginsTheySaved(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	store := fastFileVault(t, path, &machineCreds{key: 0x5a})
	l := NewLogins(store)
	if origins, err := l.List(); err != nil || len(origins) != 0 {
		t.Fatalf("List = %v, %v", origins, err)
	}
	for _, origin := range []string{"https://github.com", "https://mail.example.test", "https://github.com"} {
		if err := l.Put(origin, Login{Username: "fixture-user", Password: "fixture password"}); err != nil {
			t.Fatal(err)
		}
	}
	origins, err := NewLogins(fastFileVault(t, path, &machineCreds{key: 0x5a})).List()
	if err != nil || strings.Join(origins, " ") != "https://github.com https://mail.example.test" {
		t.Fatalf("List = %v, %v", origins, err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "github.com") {
		t.Fatal("the list of sites reached the disk in the clear")
	}
	if err := l.Delete("https://github.com"); err != nil {
		t.Fatal(err)
	}
	if err := l.Delete("https://github.com"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete twice = %v", err)
	}
	if err := l.Delete("https://mail.example.test"); err != nil {
		t.Fatal(err)
	}
	if origins, err := l.List(); err != nil || len(origins) != 0 {
		t.Fatalf("List after removing every login = %v, %v", origins, err)
	}
	if _, err := store.Get(loginOriginsID, loginOriginsBinding); !errors.Is(err, ErrNotFound) {
		t.Fatal("an empty list kept its item")
	}
}

func TestForgetClearsEveryItemAndRecord(t *testing.T) {
	store := NewMemory()
	path := filepath.Join(t.TempDir(), "secrets.json")
	v, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"weather", "maps"} {
		if err := v.Put(httpRecord(id), fakeValue); err != nil {
			t.Fatal(err)
		}
	}
	if err := NewLogins(store).Put("https://github.com", Login{Password: "fixture"}); err != nil {
		t.Fatal(err)
	}
	if err := store.Put(PushKeyID, fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	if n, err := v.Forget(); err != nil || n != 2 {
		t.Fatalf("Forget = %d, %v", n, err)
	}
	if len(v.Records()) != 0 || len(store.values) != 0 {
		t.Fatalf("left %d records and %d items", len(v.Records()), len(store.values))
	}
	if _, err := v.Value("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a forgotten key still reads: %v", err)
	}
	reopened, err := Open(NewMemory(), path)
	if err != nil || len(reopened.Records()) != 0 {
		t.Fatal("the index kept a forgotten record")
	}
}

func TestForgetNeedsAnOpenFileVault(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	f := fastFileVault(t, path, nil)
	if err := f.Unlock([]byte(testPassphrase)); err != nil {
		t.Fatal(err)
	}
	if err := f.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	locked := fastFileVault(t, path, nil)
	if err := locked.forgetAll(); !errors.Is(err, ErrLocked) {
		t.Fatalf("a locked vault forgot: %v", err)
	}
	if err := f.forgetAll(); err != nil {
		t.Fatal(err)
	}
	again := fastFileVault(t, path, nil)
	if err := again.Unlock([]byte(testPassphrase)); err != nil {
		t.Fatal("forgetting the items changed the passphrase")
	}
	if _, err := again.Get("weather", testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a forgotten item still reads: %v", err)
	}
}

func TestForgetDeletesTheKeychainClaimLast(t *testing.T) {
	k, dir := fakeKeychain(t)
	for _, id := range []string{"weather", "maps"} {
		if err := k.Put(id, longValue(maxValueLen), testBinding); err != nil {
			t.Fatal(err)
		}
	}
	store := filepath.Join(dir, "store")
	for _, name := range []string{"localdot-keyd-test._bindings", "localdot-keyd-test._session", "localdot-keyd.work.weather"} {
		if err := os.WriteFile(filepath.Join(store, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := k.forgetAll(); err != nil {
		t.Fatal(err)
	}
	left, _ := filepath.Glob(filepath.Join(store, "*"))
	if len(left) != 1 || filepath.Base(left[0]) != "localdot-keyd.work.weather" {
		t.Fatalf("left %v", left)
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	lines := strings.Split(strings.TrimSpace(string(argv)), "\n")
	if lines[len(lines)-1] != "keychain-item delete localdot-keyd-test _session" {
		t.Fatalf("the claim was not deleted last: %s", lines[len(lines)-1])
	}
}

func TestForgetClearsTheDotsKeyringService(t *testing.T) {
	s, dir := fakeSecretService(t)
	if err := s.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(dir, "items", "localdot-keyd.work.weather.head")
	if err := os.WriteFile(other, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.forgetAll(); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("weather", testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a forgotten item still reads: %v", err)
	}
	if _, err := os.Stat(other); err != nil {
		t.Fatal("another dot's item went too")
	}
	t.Setenv("FAKE_FAIL", "locked")
	if err := s.forgetAll(); err == nil {
		t.Fatal("a locked keyring reported its items cleared")
	}
}
