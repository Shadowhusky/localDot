package vault

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// machineCreds stands in for systemd-creds: it wraps by XOR with a key no file holds.
type machineCreds struct {
	key  byte
	tpm  bool
	fail bool
}

func (m *machineCreds) Encrypt(plain []byte) ([]byte, error) {
	out := make([]byte, len(plain))
	for i, b := range plain {
		out[i] = b ^ m.key
	}
	return []byte("wrapped:" + b64.EncodeToString(out)), nil
}

func (m *machineCreds) Decrypt(sealed []byte) ([]byte, error) {
	raw, err := b64.DecodeString(strings.TrimPrefix(string(sealed), "wrapped:"))
	if err != nil || m.fail {
		return nil, errors.New("cannot unwrap")
	}
	for i := range raw {
		raw[i] ^= m.key
	}
	return raw, nil
}

func (m *machineCreds) TPM() bool { return m.tpm }

func fastFileVault(t *testing.T, path string, creds Credentials) *FileVault {
	t.Helper()
	f, err := OpenFileVault(path, creds)
	if err != nil {
		t.Fatal(err)
	}
	f.iterations = 1000
	return f
}

const testPassphrase = "correct horse battery staple"

func TestFileVaultWithMachineKeyOpensUnlocked(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	creds := &machineCreds{key: 0x5a, tpm: true}
	f := fastFileVault(t, path, creds)
	if got := f.State(); got != (VaultState{Backend: "file", State: "ready", Key: "tpm"}) {
		t.Fatalf("state = %+v", got)
	}
	value := longValue(maxValueLen)
	if err := f.Put("weather", value, testBinding); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if carries(string(data), value) {
		t.Fatal("the vault file holds the value in the clear")
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("vault mode %v", info.Mode().Perm())
	}
	again := fastFileVault(t, path, creds)
	got, err := again.Get("weather", testBinding)
	if err != nil || !bytes.Equal(got, value) {
		t.Fatalf("reopened read = %d bytes, %v", len(got), err)
	}
	if _, err := OpenFileVault(path, &machineCreds{key: 0x5a, fail: true}); err == nil {
		t.Fatal("a key another machine wrapped opened")
	}
	if _, err := OpenFileVault(path, nil); err == nil {
		t.Fatal("a machine-wrapped vault opened without systemd-creds")
	}
}

func TestFileVaultBindsEachValueToItsIdAndBinding(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	f := fastFileVault(t, path, &machineCreds{key: 7})
	if err := f.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	if err := f.Put("maps", []byte("maps-secret-value"), testBinding); err != nil {
		t.Fatal(err)
	}
	other := bindingOf(httpRecord("elsewhere"))
	if _, err := f.Get("weather", other); !errors.Is(err, errRebound) {
		t.Fatalf("read for another binding = %v", err)
	}
	var file vaultFile
	data, _ := os.ReadFile(path)
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatal(err)
	}
	// Someone rewrites the file: the binding beside a value, or one item over another.
	rebound := file
	rebound.Items = map[string]fileItem{"weather": {Binding: other, Nonce: file.Items["weather"].Nonce, CT: file.Items["weather"].CT}, "maps": file.Items["maps"]}
	swapped := file
	swapped.Items = map[string]fileItem{"weather": file.Items["maps"], "maps": file.Items["weather"]}
	for name, edited := range map[string]vaultFile{"rebound": rebound, "swapped": swapped} {
		out, _ := json.Marshal(edited)
		if err := os.WriteFile(path, out, 0o600); err != nil {
			t.Fatal(err)
		}
		reopened := fastFileVault(t, path, &machineCreds{key: 7})
		if got, err := reopened.Get("weather", other); err == nil {
			t.Fatalf("%s: read %q", name, got)
		}
		if got, err := reopened.Get("weather", testBinding); name == "swapped" && err == nil {
			t.Fatalf("%s: read %q", name, got)
		}
	}
}

func TestFileVaultPassphrase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	f := fastFileVault(t, path, nil)
	if got := f.State(); got != (VaultState{Backend: "file", State: "setup"}) {
		t.Fatalf("state = %+v", got)
	}
	if err := f.Put("weather", fakeValue, testBinding); !errors.Is(err, ErrLocked) || !errors.Is(err, errUnchanged) {
		t.Fatalf("store before setup = %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("a vault file appeared before its passphrase")
	}
	if err := f.Unlock([]byte("short")); err == nil {
		t.Fatal("a short passphrase was accepted")
	}
	if err := f.Unlock([]byte(testPassphrase)); err != nil {
		t.Fatal(err)
	}
	if err := f.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if bytes.Contains(data, []byte(testPassphrase)) || carries(string(data), fakeValue) {
		t.Fatal("the vault file holds the passphrase or the value")
	}
	locked := fastFileVault(t, path, &machineCreds{key: 1})
	if got := locked.State(); got != (VaultState{Backend: "file", State: "locked", Key: "passphrase", Fingerprint: f.State().Fingerprint}) {
		t.Fatalf("reopened state = %+v", got)
	}
	if _, err := locked.Get("weather", testBinding); !errors.Is(err, ErrLocked) {
		t.Fatalf("locked read = %v", err)
	}
	if err := locked.Delete("weather"); !errors.Is(err, ErrLocked) {
		t.Fatalf("locked delete = %v", err)
	}
	if err := locked.Unlock([]byte("not the right passphrase")); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("wrong passphrase = %v", err)
	}
	if err := locked.Unlock([]byte(testPassphrase)); err != nil {
		t.Fatal(err)
	}
	if got, err := locked.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("unlocked read = %q, %v", got, err)
	}
	machine := fastFileVault(t, filepath.Join(t.TempDir(), "vault.json"), &machineCreds{key: 2})
	if err := machine.Unlock([]byte(testPassphrase)); err == nil {
		t.Fatal("a machine-unlocked vault took a passphrase")
	}
}

func TestFileVaultFingerprintNamesThePassphraseVault(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "vault.json")
	first := fastFileVault(t, path, nil)
	if err := first.Unlock([]byte(testPassphrase)); err != nil {
		t.Fatal(err)
	}
	made := first.State().Fingerprint
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(made) {
		t.Fatalf("fingerprint = %q", made)
	}
	data, _ := os.ReadFile(path)
	if bytes.Contains(data, []byte(made)) {
		t.Fatal("the fingerprint is written in the vault file")
	}
	if got := fastFileVault(t, path, nil).State().Fingerprint; got != made {
		t.Fatalf("a locked reopen says %q, want %q", got, made)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	again := fastFileVault(t, path, nil)
	if got := again.State().Fingerprint; got != "" {
		t.Fatalf("a vault waiting for its passphrase has fingerprint %q", got)
	}
	if err := again.Unlock([]byte(testPassphrase)); err != nil {
		t.Fatal(err)
	}
	if got := again.State().Fingerprint; got == "" || got == made {
		t.Fatalf("a vault made anew with the same passphrase has fingerprint %q, the old one %q", got, made)
	}
	if got := fastFileVault(t, filepath.Join(dir, "machine.json"), &machineCreds{key: 3}).State().Fingerprint; got != "" {
		t.Fatalf("a machine-unlocked vault has fingerprint %q", got)
	}
}

func TestFileVaultKeepsTheOldFileWhenAWriteFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "vault.json")
	f := fastFileVault(t, path, &machineCreds{key: 9})
	if err := f.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	f.write = func(string, []byte) error { return errors.New("disk full") }
	if err := f.Put("weather", []byte("replacement-value"), testBinding); !errors.Is(err, errUnchanged) {
		t.Fatalf("failed write = %v, want unchanged", err)
	}
	if got, err := f.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("after a failed write = %q, %v", got, err)
	}
	if err := f.Delete("weather"); err == nil {
		t.Fatal("a delete that did not reach the disk succeeded")
	}
	if _, err := f.Get("weather", testBinding); err != nil {
		t.Fatalf("a failed delete removed the value: %v", err)
	}
}

func TestFileVaultRefusesFilesItDidNotWrite(t *testing.T) {
	for name, content := range map[string]string{
		"version":    `{"v":2,"key":{"source":"systemd-creds","credential":"x"},"items":{}}`,
		"source":     `{"v":1,"key":{"source":"plaintext"},"items":{}}`,
		"iterations": `{"v":1,"key":{"source":"passphrase","kdf":"pbkdf2-sha256","iterations":999999999,"salt":"a","nonce":"b","wrapped":"c"},"items":{}}`,
		"item":       `{"v":1,"key":{"source":"systemd-creds","credential":"x"},"items":{"../x":{"binding":"b"}}}`,
	} {
		path := filepath.Join(t.TempDir(), "vault.json")
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenFileVault(path, &machineCreds{}); err == nil {
			t.Fatalf("%s: opened", name)
		}
	}
}

func TestFileVaultUnderTheVault(t *testing.T) {
	f := fastFileVault(t, filepath.Join(t.TempDir(), "vault.json"), &machineCreds{key: 3})
	v, _ := openTemp(t, f)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(f, v.path)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := reopened.Value("weather"); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value = %q, %v", got, err)
	}
	if err := reopened.Delete("weather"); err != nil {
		t.Fatal(err)
	}
}

// fakeSystemdCreds answers encrypt and decrypt like systemd-creds, wrapping by name so a credential
// made under another name does not decrypt.
const fakeSystemdCreds = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/argv.log"
op=$1; shift
name=; user=
for arg in "$@"; do
  case "$arg" in --name=*) name=${arg#--name=} ;; --user) user=1 ;; esac
done
case "$op" in
  has-tpm2) [ "$FAKE_TPM" = 1 ] ;;
  encrypt) [ -z "$FAKE_NO_USER" ] || [ -z "$user" ] || exit 1; printf 'cred:%s:' "$name"; base64 | tr -d '\n'; echo ;;
  decrypt) read -r line; case "$line" in "cred:$name:"*) printf '%s' "${line#cred:$name:}" | base64 -d ;; *) exit 1 ;; esac ;;
  *) exit 2 ;;
esac
`

func TestSystemdCredsWrapsTheVaultKey(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "systemd-creds")
	if err := os.WriteFile(bin, []byte(fakeSystemdCreds), 0o700); err != nil {
		t.Fatal(err)
	}
	creds := &SystemdCreds{user: true, tool: tool{path: bin, env: []string{"PATH=/usr/bin:/bin"}, configureCommand: func(cmd *exec.Cmd) {
		cmd.Env = append(cmd.Env, "FAKE_DIR="+dir, "FAKE_TPM=1")
	}}}
	if err := creds.probe(); err != nil || !creds.TPM() {
		t.Fatalf("probe = %v, tpm %v", err, creds.TPM())
	}
	path := filepath.Join(dir, "vault.json")
	f := fastFileVault(t, path, creds)
	if err := f.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	reopened := fastFileVault(t, path, creds)
	if got, err := reopened.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("read = %q, %v", got, err)
	}
	if reopened.State().Key != "tpm" {
		t.Fatalf("state = %+v", reopened.State())
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if !strings.Contains(string(argv), "encrypt --name=localdot-keyd-vault --user - -") {
		t.Fatalf("argv = %s", argv)
	}
	if carries(string(argv), fakeValue) {
		t.Fatal("a value travelled in argv")
	}
	creds.tool.configureCommand = func(cmd *exec.Cmd) {
		cmd.Env = append(cmd.Env, "FAKE_DIR="+dir, "FAKE_NO_USER=1")
	}
	if creds.probe() == nil {
		t.Fatal("a systemd-creds without a user scope passed the probe")
	}
}

func TestPassphraseSealsOpenOnlyAsPassphrases(t *testing.T) {
	o, err := NewOpener()
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := SealPassphrase(o.PublicKey(), []byte(testPassphrase))
	if err != nil {
		t.Fatal(err)
	}
	if got, err := o.OpenPassphrase(sealed); err != nil || string(got) != testPassphrase {
		t.Fatalf("OpenPassphrase = %q, %v", got, err)
	}
	if _, err := o.Open(sealed, httpRecord("weather")); err == nil {
		t.Fatal("a passphrase opened as a secret")
	}
	secret, err := Seal(o.PublicKey(), httpRecord("weather"), fakeValue)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.OpenPassphrase(secret); err == nil {
		t.Fatal("a secret opened as a passphrase")
	}
}

// TestRealSystemdCreds runs against this machine's systemd-creds; the Linux test image provides it.
func TestRealSystemdCreds(t *testing.T) {
	if os.Getenv("KEYD_SYSTEMD_CREDS_IT") != "1" {
		t.Skip("needs systemd-creds (KEYD_SYSTEMD_CREDS_IT=1)")
	}
	creds := FindSystemdCreds(os.Getenv)
	if creds == nil {
		t.Fatal("systemd-creds cannot wrap keys here")
	}
	path := filepath.Join(t.TempDir(), "vault.json")
	f := fastFileVault(t, path, creds)
	if err := f.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	reopened := fastFileVault(t, path, FindSystemdCreds(os.Getenv))
	if got, err := reopened.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("read = %q, %v", got, err)
	}
	data, _ := os.ReadFile(path)
	if carries(string(data), fakeValue) {
		t.Fatal("the vault file holds the value")
	}
}
