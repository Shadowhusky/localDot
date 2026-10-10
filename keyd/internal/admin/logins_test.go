package admin

import (
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"os"
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
