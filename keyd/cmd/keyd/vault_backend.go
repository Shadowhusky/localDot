package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

var vaultModes = []string{"auto", "keychain", "secret-service", "file", "passphrase", "memory"}

// defaultVaultMode keeps the Keychain on macOS; elsewhere keyd picks what the machine has.
func defaultVaultMode(goos string) string {
	if goos == "darwin" {
		return "keychain"
	}
	return "auto"
}

// vaultHost is what keyd may find on this machine; tests replace each part.
type vaultHost struct {
	goos     string
	keychain func() (vault.Store, error)
	keyring  func() (vault.Store, error)
	creds    func() vault.Credentials
}

type vaultBackend struct {
	store  vault.Store
	index  string
	state  func() vault.VaultState
	unlock func(passphrase []byte) error
}

// openVaultBackend opens the store mode names. auto chooses once and records the choice, so a
// keyring that is locked one day never sends keyd to an empty file vault the next.
func openVaultBackend(mode, dir string, host vaultHost) (vaultBackend, error) {
	index := filepath.Join(dir, "secrets.json")
	if mode == "auto" {
		chosen, err := chooseVaultBackend(dir, host)
		if err != nil {
			return vaultBackend{}, err
		}
		mode = chosen
	}
	ready := func(name string) func() vault.VaultState {
		return func() vault.VaultState { return vault.VaultState{Backend: name, State: "ready"} }
	}
	switch mode {
	case "memory":
		return vaultBackend{store: vault.NewMemory(), state: ready("memory")}, nil
	case "keychain":
		if host.goos != "darwin" {
			return vaultBackend{}, errors.New("keyd: the Keychain vault is only on macOS; use -vault auto")
		}
		store, err := host.keychain()
		if err != nil {
			return vaultBackend{}, errors.New("keyd: the Keychain vault requires a signed native keyd build")
		}
		return vaultBackend{store: store, index: index, state: ready("keychain")}, nil
	case "secret-service":
		store, err := host.keyring()
		if err != nil {
			return vaultBackend{}, errors.New("keyd: no unlocked keyring answers in this session; unlock it by signing in to the desktop, then start keyd again")
		}
		return vaultBackend{store: store, index: index, state: ready("secret-service")}, nil
	case "file":
		file, err := vault.OpenFileVault(filepath.Join(dir, "vault.json"), host.creds())
		if err != nil {
			return vaultBackend{}, fmt.Errorf("keyd: %w", err)
		}
		return vaultBackend{store: file, index: index, state: file.State, unlock: file.Unlock}, nil
	case "passphrase":
		// A file only the passphrase opens: unlike the keyring or systemd-creds, a program running
		// as this user can't read the keys from disk or while keyd is locked. After an unlock it
		// can, having replaced keyd, localdot or the unit to catch the passphrase, or through
		// ptrace where that is open. Its own file, so a vault.json made for systemd-creds never
		// stops keyd from starting.
		file, err := vault.OpenFileVault(filepath.Join(dir, "vault-passphrase.json"), nil)
		if err != nil {
			return vaultBackend{}, fmt.Errorf("keyd: %w", err)
		}
		return vaultBackend{store: file, index: index, state: file.State, unlock: file.Unlock}, nil
	}
	return vaultBackend{}, fmt.Errorf("keyd: unknown vault mode %q", mode)
}

type vaultChoice struct {
	V       int    `json:"v"`
	Backend string `json:"backend"`
}

func chooseVaultBackend(dir string, host vaultHost) (string, error) {
	if host.goos == "darwin" {
		return "keychain", nil
	}
	path := filepath.Join(dir, "vault-backend.json")
	data, err := os.ReadFile(path)
	if err == nil {
		var choice vaultChoice
		if json.Unmarshal(data, &choice) != nil || choice.V != 1 || (choice.Backend != "secret-service" && choice.Backend != "file") {
			return "", fmt.Errorf("keyd: %s is not keyd's", path)
		}
		return choice.Backend, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	backend := "file"
	if _, err := host.keyring(); err == nil {
		backend = "secret-service"
	}
	out, _ := json.Marshal(vaultChoice{V: 1, Backend: backend})
	if err := writePrivateFile(path, out); err != nil {
		return "", err
	}
	return backend, nil
}

func writePrivateFile(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// systemVaultHost is the real machine.
func systemVaultHost(goos string) vaultHost {
	return vaultHost{
		goos: goos,
		keychain: func() (vault.Store, error) {
			k := vault.NewKeychain(keychainService)
			return k, k.Check()
		},
		keyring: func() (vault.Store, error) {
			s := vault.NewSecretService(keychainService, os.Getenv)
			return s, s.Check()
		},
		creds: func() vault.Credentials {
			if c := vault.FindSystemdCreds(os.Getenv); c != nil {
				return c
			}
			return nil
		},
	}
}
