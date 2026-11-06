package admin

import (
	"bytes"
	"encoding/json"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrivateLoginChannelDoesNotExposeCredentialsInIndexOrAudit(t *testing.T) {
	f := newFixture(t)
	f.s.Logins = vault.NewLogins(vault.NewMemory())
	login := map[string]string{"origin": "https://github.com", "username": "fixture-account", "password": "private-login-canary"}
	code, _ := f.call(t, "PUT", "/v1/logins", login)
	if code != 200 {
		t.Fatal("could not save login")
	}
	code, got := f.call(t, "POST", "/v1/logins", map[string]string{"origin": "https://github.com"})
	if code != 200 || got["username"] != login["username"] || got["password"] != login["password"] {
		t.Fatal("private channel did not return saved login")
	}
	if len(f.s.Vault.Records()) != 0 {
		t.Fatal("login entered API key index")
	}
	audit, _ := os.ReadFile(f.auditLog)
	if strings.Contains(string(audit), login["password"]) || strings.Contains(string(audit), login["username"]) {
		t.Fatal("credential leaked to audit")
	}
	code, _ = f.call(t, "POST", "/v1/logins", map[string]string{"origin": "https://other.example"})
	if code != 404 {
		t.Fatal("login crossed origin")
	}
	code, _ = f.call(t, "DELETE", "/v1/logins", map[string]string{"origin": "https://github.com"})
	if code != 200 {
		t.Fatal("could not remove saved login")
	}
	code, _ = f.call(t, "POST", "/v1/logins", map[string]string{"origin": "https://github.com"})
	if code != 404 {
		t.Fatal("deleted login survived")
	}
}

const (
	importedPassword = "canary-imported-password-7f3a"
	importedAccount  = "canary-account-7f3a@example.com"
	importedNote     = "canary-note-7f3a"
	brokenCell       = "canary-broken-cell-7f3a"
)

func loginServer(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	f.s.Logins = vault.NewLogins(vault.NewMemory())
	return f
}

func sealedLogin(t *testing.T, f *fixture, login map[string]any) map[string]any {
	t.Helper()
	raw, _ := json.Marshal(login)
	sealed, err := vault.SealLogin(f.s.Opener.PublicKey(), raw)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]any{"sealed": sealed}
}

func TestSealedLoginIsAddedEditedAndListedWithoutItsPassword(t *testing.T) {
	f := loginServer(t)
	code, got := f.call(t, "POST", "/v1/logins/sealed", sealedLogin(t, f, map[string]any{"origin": "https://github.com", "username": "octo", "password": "fixture-password"}))
	if code != 200 || got["origin"] != "https://github.com" || got["username"] != "octo" || got["confirm"] != true || got["password"] != nil {
		t.Fatalf("%d %v", code, got)
	}
	code, got = f.call(t, "POST", "/v1/logins/sealed", sealedLogin(t, f, map[string]any{"origin": "https://github.com", "username": "renamed"}))
	if code != 200 || got["username"] != "renamed" {
		t.Fatalf("%d %v", code, got)
	}
	code, held := f.call(t, "POST", "/v1/logins", map[string]string{"origin": "https://github.com"})
	if code != 200 || held["password"] != "fixture-password" || held["username"] != "renamed" {
		t.Fatal("editing the account changed the password")
	}
	code, list := f.call(t, "GET", "/v1/logins", nil)
	raw, _ := json.Marshal(list)
	if code != 200 || !strings.Contains(string(raw), "renamed") || strings.Contains(string(raw), "fixture-password") {
		t.Fatalf("%d %s", code, raw)
	}
	code, found := f.call(t, "POST", "/v1/logins/find", map[string]string{"origin": "https://github.com"})
	raw, _ = json.Marshal(found)
	if code != 200 || found["username"] != "renamed" || strings.Contains(string(raw), "fixture-password") {
		t.Fatalf("%d %s", code, raw)
	}
	if code, _ = f.call(t, "POST", "/v1/logins/find", map[string]string{"origin": "https://sub.github.com"}); code != 404 {
		t.Fatal("found a login on another site")
	}
	audit, _ := os.ReadFile(f.auditLog)
	if strings.Contains(string(audit), "fixture-password") || strings.Contains(string(audit), "renamed") || strings.Contains(string(audit), "github.com") {
		t.Fatal("a login reached the audit log")
	}
}

func TestSealedLoginRefusesWhatItCannotBind(t *testing.T) {
	f := loginServer(t)
	for _, bad := range []map[string]any{
		{"origin": "http://github.com", "username": "a", "password": "p"},
		{"origin": "https://github.com/login", "username": "a", "password": "p"},
		{"origin": "https://github.com", "username": "a", "password": ""},
		{"origin": "https://github.com", "username": "a", "password": "bell\u0007"},
		{"origin": "https://github.com", "username": "a", "password": strings.Repeat("x", 1001)},
	} {
		if code, _ := f.call(t, "POST", "/v1/logins/sealed", sealedLogin(t, f, bad)); code != 400 {
			t.Fatalf("took %v", bad)
		}
	}
	if code, _ := f.call(t, "POST", "/v1/logins/sealed", sealedLogin(t, f, map[string]any{"origin": "https://github.com", "username": "a"})); code != 404 {
		t.Fatal("an account was saved with no password")
	}
	sealed, _ := vault.SealPassphrase(f.s.Opener.PublicKey(), []byte(`{"origin":"https://github.com","username":"a","password":"p"}`))
	if code, got := f.call(t, "POST", "/v1/logins/sealed", map[string]any{"sealed": sealed}); code != 400 || got["error"].(map[string]any)["code"] != "bad-seal" {
		t.Fatalf("opened a passphrase's seal as a login: %d %v", code, got)
	}
	sealed, _ = vault.SealLogin(f.s.Opener.PublicKey(), []byte("url,password\nhttps://a.example.com,p\n"))
	if code, _ := f.call(t, "POST", "/v1/logins/import", map[string]any{"sealed": sealed}); code != 400 {
		t.Fatal("opened a login's seal as an export")
	}
}

func TestImportedExportLeavesNothingBehindButTheStore(t *testing.T) {
	f := loginServer(t)
	var logged bytes.Buffer
	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	file := "name,url,username,password,note\n" +
		"Site," + "https://site.example.com/login," + importedAccount + "," + importedPassword + "," + importedNote + "\n" +
		"Plain,http://plain.example.com," + importedAccount + "," + importedPassword + "," + importedNote + "\n" +
		"Empty,https://empty.example.com," + importedAccount + ",," + importedNote + "\n" +
		"Broken,https://broken.example.com," + importedAccount + ",\"" + brokenCell + "\n"
	sealed, err := vault.SealLoginImport(f.s.Opener.PublicKey(), []byte(file))
	if err != nil {
		t.Fatal(err)
	}
	code, got := f.call(t, "POST", "/v1/logins/import", map[string]any{"sealed": sealed})
	if code != 200 || got["rows"] != float64(4) || got["imported"] != float64(1) || got["alreadySaved"] != float64(0) {
		t.Fatalf("%d %v", code, got)
	}
	code, again := f.call(t, "POST", "/v1/logins/import", map[string]any{"sealed": sealed})
	if code != 200 || again["imported"] != float64(0) || again["alreadySaved"] != float64(1) {
		t.Fatalf("%d %v", code, again)
	}
	held, err := f.s.Logins.Get("https://site.example.com")
	if err != nil || held.Password != importedPassword || !held.Confirm {
		t.Fatalf("%+v, %v", held, err)
	}
	reply, _ := json.Marshal([]any{got, again})
	audit, _ := os.ReadFile(f.auditLog)
	index, _ := json.Marshal(f.s.Vault.Records())
	for where, text := range map[string]string{"reply": string(reply), "audit": string(audit), "log": logged.String(), "index": string(index)} {
		for _, canary := range []string{importedPassword, importedAccount, importedNote, brokenCell, "site.example.com"} {
			if strings.Contains(text, canary) {
				t.Fatalf("%s holds %s", where, canary)
			}
		}
	}
	for _, canary := range []string{importedPassword, importedAccount, importedNote, brokenCell} {
		if strings.Contains(string(reply), canary) {
			t.Fatal(canary)
		}
	}
	notAnExport, _ := vault.SealLoginImport(f.s.Opener.PublicKey(), []byte("a,b\n"+importedPassword+",x\n"))
	code, refusal := f.call(t, "POST", "/v1/logins/import", map[string]any{"sealed": notAnExport})
	raw, _ := json.Marshal(refusal)
	if code != 422 || strings.Contains(string(raw), importedPassword) {
		t.Fatalf("%d %s", code, raw)
	}
}

func TestImportTakesAnExportOverTheUsualBodyLimit(t *testing.T) {
	f := loginServer(t)
	file := "url,password,note\nhttps://big.example.com,p," + strings.Repeat("n", 3<<20) + "\n"
	sealed, _ := vault.SealLoginImport(f.s.Opener.PublicKey(), []byte(file))
	if code, got := f.call(t, "POST", "/v1/logins/import", map[string]any{"sealed": sealed}); code != 200 || got["imported"] != float64(1) {
		t.Fatalf("%d %v", code, got)
	}
}

func TestSavedLoginsAreOfferedInStatus(t *testing.T) {
	f := loginServer(t)
	_, got := f.call(t, "GET", "/v1/status", nil)
	if got["savedLogins"] != true {
		t.Fatal("status doesn't say saved logins can be managed")
	}
}

func TestForgetEmptiesTheLoginList(t *testing.T) {
	f := loginServer(t)
	store := vault.NewMemory()
	var err error
	f.s.Vault, err = vault.Open(store, filepath.Join(t.TempDir(), "secrets.json"))
	if err != nil {
		t.Fatal(err)
	}
	f.s.Logins = vault.NewLogins(store)
	if err := f.s.Logins.Put("https://github.com", vault.Login{Username: "a", Password: "p"}); err != nil {
		t.Fatal(err)
	}
	if code, got := f.call(t, "POST", "/v1/vault/forget", map[string]string{"confirm": "forget"}); code != 200 || got["logins"] != float64(1) {
		t.Fatalf("%d %v", code, got)
	}
	if entries, err := f.s.Logins.Entries(); err != nil || len(entries) != 0 {
		t.Fatalf("still listed %v, %v", entries, err)
	}
}
