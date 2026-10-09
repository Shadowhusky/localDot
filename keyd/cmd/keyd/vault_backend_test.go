package main

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func fakeHost(goos string, keyring bool) vaultHost {
	return vaultHost{
		goos:     goos,
		keychain: func() (vault.Store, error) { return vault.NewMemory(), nil },
		keyring: func() (vault.Store, error) {
			if !keyring {
				return nil, errors.New("no keyring")
			}
			return vault.NewMemory(), nil
		},
		creds: func() vault.Credentials { return nil },
	}
}

func TestDefaultVaultKeepsTheKeychainOnMacOS(t *testing.T) {
	if defaultVaultMode("darwin") != "keychain" || defaultVaultMode("linux") != "auto" {
		t.Fatal("wrong default vault")
	}
	dir := t.TempDir()
	backend, err := openVaultBackend("auto", dir, fakeHost("darwin", true))
	if err != nil || backend.state().Backend != "keychain" || backend.unlock != nil {
		t.Fatalf("macOS auto = %+v, %v", backend.state(), err)
	}
	if _, err := os.Stat(filepath.Join(dir, "vault-backend.json")); !os.IsNotExist(err) {
		t.Fatal("macOS recorded a choice it never needs")
	}
	if _, err := openVaultBackend("keychain", dir, fakeHost("linux", true)); err == nil || !strings.Contains(err.Error(), "only on macOS") {
		t.Fatalf("Keychain on Linux = %v", err)
	}
}

func TestAutoVaultChoosesOnceAndKeepsItsChoice(t *testing.T) {
	dir := t.TempDir()
	backend, err := openVaultBackend("auto", dir, fakeHost("linux", true))
	if err != nil || backend.state().Backend != "secret-service" {
		t.Fatalf("with a keyring = %+v, %v", backend, err)
	}
	// The keyring is locked on the next start: keyd says so instead of moving to an empty vault.
	if _, err := openVaultBackend("auto", dir, fakeHost("linux", false)); err == nil || !strings.Contains(err.Error(), "keyring") {
		t.Fatalf("a locked keyring = %v", err)
	}
	headless := t.TempDir()
	backend, err = openVaultBackend("auto", headless, fakeHost("linux", false))
	if err != nil || backend.state() != (vault.VaultState{Backend: "file", State: "setup"}) || backend.unlock == nil {
		t.Fatalf("headless = %+v, %v", backend.state(), err)
	}
	backend, err = openVaultBackend("auto", headless, fakeHost("linux", true))
	if err != nil || backend.state().Backend != "file" {
		t.Fatalf("a keyring that appears later moved the vault: %+v, %v", backend.state(), err)
	}
	if err := os.WriteFile(filepath.Join(headless, "vault-backend.json"), []byte(`{"v":1,"backend":"plaintext"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openVaultBackend("auto", headless, fakeHost("linux", true)); err == nil {
		t.Fatal("an unknown recorded choice was used")
	}
}

func TestFileVaultUnlocksThroughTheAdminSocket(t *testing.T) {
	home := shortHome(t)
	host := fakeHost("linux", false)
	d, err := start(Config{Home: home, Vault: "file", Ports: egress.PortRange{}, host: &host})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	admin := socketClient(d.Socket)
	code, status := adminCall(t, admin, "GET", "/v1/status", nil)
	if code != 200 || status["vault"].(map[string]any)["state"] != "setup" {
		t.Fatalf("status = %d %v", code, status["vault"])
	}
	key := status["sealKey"].(string)
	rec := vault.Record{ID: "anthropic", Kind: vault.KindLLM, Provider: "anthropic"}
	secret, _ := vault.Seal(key, rec, []byte("real-secret-value-for-test"))
	body := map[string]any{"kind": "llm", "provider": "anthropic", "sealed": secret}
	if code, reply := adminCall(t, admin, "PUT", "/v1/secrets/anthropic", body); code != 423 || reply["error"].(map[string]any)["code"] != "vault-locked" {
		t.Fatalf("a secret was stored before the vault had a passphrase: %d %v", code, reply)
	}
	asSecret, _ := vault.Seal(key, rec, []byte("correct horse battery staple"))
	if code, _ := adminCall(t, admin, "POST", "/v1/vault/unlock", map[string]any{"sealed": asSecret}); code != 400 {
		t.Fatalf("a passphrase sealed as a secret = %d", code)
	}
	pass, _ := vault.SealPassphrase(key, []byte("correct horse battery staple"))
	code, state := adminCall(t, admin, "POST", "/v1/vault/unlock", map[string]any{"sealed": pass})
	fingerprint, _ := state["fingerprint"].(string)
	if code != 200 || state["state"] != "ready" || state["key"] != "passphrase" || len(fingerprint) != 32 {
		t.Fatalf("unlock = %d %v", code, state)
	}
	if code, _ := adminCall(t, admin, "PUT", "/v1/secrets/anthropic", body); code != 200 {
		t.Fatalf("store after unlock = %d", code)
	}
	d.Close()

	d, err = start(Config{Home: home, Vault: "file", Ports: egress.PortRange{}, host: &host})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	admin = socketClient(d.Socket)
	_, status = adminCall(t, admin, "GET", "/v1/status", nil)
	if v := status["vault"].(map[string]any); v["state"] != "locked" || v["fingerprint"] != fingerprint {
		t.Fatalf("restarted vault = %v", status["vault"])
	}
	locked, _ := vault.Seal(status["sealKey"].(string), rec, []byte("real-secret-value-for-test"))
	body["sealed"] = locked
	if code, _ := adminCall(t, admin, "PUT", "/v1/secrets/anthropic", body); code != 423 {
		t.Fatalf("store while locked = %d", code)
	}
	if code, _ := adminCall(t, admin, "DELETE", "/v1/secrets/anthropic", nil); code != 423 {
		t.Fatalf("delete while locked = %d", code)
	}
	wrong, _ := vault.SealPassphrase(status["sealKey"].(string), []byte("not the passphrase at all"))
	if code, _ := adminCall(t, admin, "POST", "/v1/vault/unlock", map[string]any{"sealed": wrong}); code != 403 {
		t.Fatalf("wrong passphrase = %d", code)
	}
	right, _ := vault.SealPassphrase(status["sealKey"].(string), []byte("correct horse battery staple"))
	if code, _ := adminCall(t, admin, "POST", "/v1/vault/unlock", map[string]any{"sealed": right}); code != 200 {
		t.Fatalf("right passphrase = %d", code)
	}
	data, _ := os.ReadFile(filepath.Join(home, "keyd", "vault.json"))
	if strings.Contains(string(data), "real-secret-value-for-test") || strings.Contains(string(data), "correct horse") {
		t.Fatal("the vault file holds a value or the passphrase")
	}
}

func TestMemoryVaultHasNoPassphrase(t *testing.T) {
	d, err := start(Config{Home: shortHome(t), Vault: "memory", Ports: egress.PortRange{}})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	admin := socketClient(d.Socket)
	_, status := adminCall(t, admin, "GET", "/v1/status", nil)
	if status["vault"].(map[string]any)["backend"] != "memory" {
		t.Fatalf("status vault = %v", status["vault"])
	}
	pass, _ := vault.SealPassphrase(status["sealKey"].(string), []byte("correct horse battery staple"))
	if code, _ := adminCall(t, admin, "POST", "/v1/vault/unlock", map[string]any{"sealed": pass}); code != 409 {
		t.Fatalf("unlock without a passphrase vault = %d", code)
	}
}

type plainCreds struct{}

func (plainCreds) Encrypt(plain []byte) ([]byte, error)  { return slices.Clone(plain), nil }
func (plainCreds) Decrypt(sealed []byte) ([]byte, error) { return slices.Clone(sealed), nil }
func (plainCreds) TPM() bool                             { return false }

// The passphrase vault never lets systemd-creds open it, and a vault made for systemd-creds
// stays where it is.
func TestPassphraseVaultIgnoresSystemdCreds(t *testing.T) {
	dir := t.TempDir()
	host := fakeHost("linux", true)
	host.creds = func() vault.Credentials { return plainCreds{} }
	made, err := openVaultBackend("file", dir, host)
	if err != nil || made.state().Key != "host" {
		t.Fatalf("file vault: %v %+v", err, made.state())
	}
	backend, err := openVaultBackend("passphrase", dir, host)
	if err != nil {
		t.Fatal(err)
	}
	if state := backend.state(); state.Backend != "file" || state.State != "setup" {
		t.Fatalf("passphrase vault opened as %+v", state)
	}
	if err := backend.unlock([]byte("correct horse battery staple")); err != nil {
		t.Fatal(err)
	}
	if state := backend.state(); state.State != "ready" || state.Key != "passphrase" {
		t.Fatalf("after its passphrase: %+v", state)
	}
	if _, err := os.Stat(filepath.Join(dir, "vault.json")); err != nil {
		t.Fatalf("the systemd-creds vault was touched: %v", err)
	}
}
