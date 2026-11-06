package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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

func TestLoginsListThatOutgrowsOneItemStaysWhole(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	creds := &machineCreds{key: 0x5a, tpm: true}
	l := NewLogins(fastFileVault(t, path, creds))
	const count = 400
	for i := range count {
		if err := l.Put(fmt.Sprintf("https://site-%03d.example.com", i), Login{Username: fmt.Sprintf("account-%03d@example.com", i), Password: "fixture-password"}); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := NewLogins(fastFileVault(t, path, creds)).Entries()
	if err != nil || len(entries) != count {
		t.Fatalf("listed %d of %d after reopening: %v", len(entries), count, err)
	}
	if entries[399].Username != "account-399@example.com" {
		t.Fatal("the list lost its order or an account")
	}
	if err := l.Delete("https://site-000.example.com"); err != nil {
		t.Fatal(err)
	}
	again := NewLogins(fastFileVault(t, path, creds))
	if listed, _ := again.List(); len(listed) != count-1 || slices.Contains(listed, "https://site-000.example.com") {
		t.Fatal("a removed login stayed listed")
	}
}

func TestLoginsMoveOverFromTheOriginsList(t *testing.T) {
	store := NewMemory()
	id, binding, _ := loginIdentity("https://github.com")
	raw, _ := json.Marshal(Login{Username: "fixture-user", Password: "fixture-password"})
	if err := store.Put(id, raw, binding); err != nil {
		t.Fatal(err)
	}
	origins, _ := json.Marshal([]string{"https://github.com", "https://gone.example.com"})
	if err := store.Put(loginOriginsID, origins, loginOriginsBinding); err != nil {
		t.Fatal(err)
	}
	entries, err := NewLogins(store).Entries()
	if err != nil || len(entries) != 1 || entries[0].Username != "fixture-user" {
		t.Fatalf("got %v, %v", entries, err)
	}
	if _, err := store.Get(loginOriginsID, loginOriginsBinding); !errors.Is(err, ErrNotFound) {
		t.Fatal("the origins list stayed behind")
	}
	if entries, _ := NewLogins(store).Entries(); len(entries) != 1 {
		t.Fatal("the moved list did not last")
	}
}

func TestLoginsTapStaysWhenTheLoginIsSavedAgain(t *testing.T) {
	l := NewLogins(NewMemory())
	if err := l.Put("https://github.com", Login{Username: "a", Password: "one", Confirm: true}); err != nil {
		t.Fatal(err)
	}
	if err := l.Put("https://github.com", Login{Username: "a", Password: "two"}); err != nil {
		t.Fatal(err)
	}
	got, err := l.Get("https://github.com")
	if err != nil || !got.Confirm || got.Password != "two" {
		t.Fatalf("got %+v, %v", got, err)
	}
	entry, err := l.Find("https://github.com")
	if err != nil || !entry.Confirm {
		t.Fatalf("got %+v, %v", entry, err)
	}
	if _, err := l.Find("https://sub.github.com"); !errors.Is(err, ErrNotFound) {
		t.Fatal("found a login across origins")
	}
}

func TestLoginsImportKeepsWhatIsSavedAndWritesTheListOnce(t *testing.T) {
	store := &listWrites{Store: NewMemory()}
	l := NewLogins(store)
	if err := l.Put("https://kept.example.com", Login{Username: "kept", Password: "kept-password"}); err != nil {
		t.Fatal(err)
	}
	store.lists = 0
	saved, already, err := l.Import([]ExportedLogin{
		{Line: 2, Origin: "https://kept.example.com", Login: Login{Username: "new", Password: "new-password", Confirm: true}},
		{Line: 3, Origin: "https://a.example.com", Login: Login{Username: "a", Password: "a-password", Confirm: true}},
		{Line: 4, Origin: "https://b.example.com", Login: Login{Username: "b", Password: "b-password", Confirm: true}},
	})
	if err != nil || saved != 2 || !slices.Equal(already, []int{2}) {
		t.Fatalf("saved %d, already %v, %v", saved, already, err)
	}
	if store.lists != 1 {
		t.Fatalf("wrote the list %d times", store.lists)
	}
	if kept, _ := l.Get("https://kept.example.com"); kept.Password != "kept-password" {
		t.Fatal("an import replaced a saved login")
	}
}

type listWrites struct {
	Store
	lists int
}

func (c *listWrites) Put(id string, value []byte, binding string) error {
	if strings.HasPrefix(id, "login-list-") {
		c.lists++
	}
	return c.Store.Put(id, value, binding)
}
