package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"strconv"
	"sync"
)

// FileVault keeps values in one encrypted file, for machines with no keyring such as servers. A
// random 256-bit key encrypts each value with AES-256-GCM, its id and binding in the AAD, so a value
// moved to another id or binding does not open. The key is written only wrapped: by systemd-creds
// (this machine's host key, and its TPM when it has one) or by a key derived from the user's
// passphrase, which keyd holds in memory only.
type FileVault struct {
	path  string
	creds Credentials
	write func(path string, data []byte) error
	// Tests lower it; files record the count they were made with.
	iterations int
	mu         sync.Mutex
	file       *vaultFile
	key        []byte
}

type vaultFile struct {
	V     int                 `json:"v"`
	Key   wrappedKey          `json:"key"`
	Items map[string]fileItem `json:"items"`
}

type wrappedKey struct {
	Source     string `json:"source"`
	TPM        bool   `json:"tpm,omitempty"`
	Credential string `json:"credential,omitempty"`
	KDF        string `json:"kdf,omitempty"`
	Iterations int    `json:"iterations,omitempty"`
	Salt       string `json:"salt,omitempty"`
	Nonce      string `json:"nonce,omitempty"`
	Wrapped    string `json:"wrapped,omitempty"`
}

type fileItem struct {
	Binding string `json:"binding"`
	Nonce   string `json:"nonce"`
	CT      string `json:"ct"`
}

const (
	fileVaultVersion  = 1
	sourceCredentials = "systemd-creds"
	sourcePassphrase  = "passphrase"
	kdfPBKDF2         = "pbkdf2-sha256"
	// OWASP's 2023 figure for PBKDF2-HMAC-SHA256.
	passphraseIterations = 600_000
	MinPassphraseLen     = 12
	maxPassphraseLen     = 1024
	fileItemInfo         = "localdot-keyd file vault item v1"
	fileKeyInfo          = "localdot-keyd file vault key v1"
	fileFingerprintInfo  = "localdot-keyd file vault fingerprint v1"
)

var (
	// ErrLocked means the vault waits for the passphrase that unwraps its key.
	ErrLocked = errors.New("vault: the key vault is locked; unlock it with your passphrase")
	// ErrPassphrase means the passphrase does not unwrap the key.
	ErrPassphrase   = errors.New("vault: that passphrase does not unlock the key vault")
	errNoPassphrase = errors.New("vault: this key vault is unlocked by the machine, not a passphrase")
)

// OpenFileVault reads the vault at path. A vault wrapped by systemd-creds opens unlocked; one wrapped
// by a passphrase opens locked. A missing file is made now when creds can wrap its key, and otherwise
// waits for the first passphrase. creds may be nil.
func OpenFileVault(path string, creds Credentials) (*FileVault, error) {
	f := &FileVault{path: path, creds: creds, write: writeFileAtomic, iterations: passphraseIterations}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if creds == nil {
			return f, nil
		}
		return f, f.create(func(key []byte) (wrappedKey, error) { return wrapWithCredentials(creds, key) })
	}
	if err != nil {
		return nil, err
	}
	var file vaultFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("key vault %s: %w", path, err)
	}
	if err := file.check(); err != nil {
		return nil, fmt.Errorf("key vault %s: %w", path, err)
	}
	f.file = &file
	if file.Key.Source == sourceCredentials {
		if creds == nil {
			return nil, fmt.Errorf("key vault %s: systemd-creds is needed to unwrap its key and does not work here", path)
		}
		sealed, err := base64.StdEncoding.DecodeString(file.Key.Credential)
		if err != nil {
			return nil, fmt.Errorf("key vault %s: its wrapped key is damaged", path)
		}
		plain, err := creds.Decrypt(sealed)
		if err != nil {
			return nil, err
		}
		key, err := hex.DecodeString(string(plain))
		clear(plain)
		if err != nil || len(key) != 32 {
			return nil, fmt.Errorf("key vault %s: its wrapped key is damaged", path)
		}
		f.key = key
	}
	return f, nil
}

func (file *vaultFile) check() error {
	if file.V != fileVaultVersion {
		return fmt.Errorf("version %d, want %d", file.V, fileVaultVersion)
	}
	k := file.Key
	switch {
	case k.Source == sourceCredentials && k.Credential != "":
	case k.Source == sourcePassphrase && k.KDF == kdfPBKDF2 && k.Iterations >= 1 && k.Iterations <= 10*passphraseIterations &&
		k.Salt != "" && k.Nonce != "" && k.Wrapped != "":
	default:
		return errors.New("its key is wrapped in a way keyd does not know")
	}
	if file.Items == nil {
		file.Items = map[string]fileItem{}
	}
	for id, item := range file.Items {
		if !idPattern.MatchString(id) || !bindingPattern.MatchString(item.Binding) {
			return fmt.Errorf("item %q is not keyd's", id)
		}
	}
	return nil
}

// VaultState says where values live and whether they can be read now.
type VaultState struct {
	Backend string `json:"backend"`
	// ready, locked, or setup: a file vault that waits for its first passphrase.
	State string `json:"state"`
	// What unwraps a file vault's key: tpm, host or passphrase.
	Key string `json:"key,omitempty"`
	// Names a passphrase vault: one made anew, even with the same passphrase, has another.
	Fingerprint string `json:"fingerprint,omitempty"`
}

func (f *FileVault) State() VaultState {
	f.mu.Lock()
	defer f.mu.Unlock()
	state := VaultState{Backend: "file", State: "ready"}
	switch {
	case f.file == nil:
		state.State = "setup"
	case f.key == nil:
		state.State = "locked"
	}
	switch {
	case f.file == nil:
	case f.file.Key.Source == sourcePassphrase:
		state.Key = "passphrase"
		state.Fingerprint = passphraseFingerprint(f.file.Key.Salt)
	case f.file.Key.TPM:
		state.Key = "tpm"
	default:
		state.Key = "host"
	}
	return state
}

// Unlock unwraps the key with passphrase. A vault still waiting for its first passphrase is made
// with it. A vault the machine unlocks refuses a passphrase.
func (f *FileVault) Unlock(passphrase []byte) error {
	if len(passphrase) < MinPassphraseLen || len(passphrase) > maxPassphraseLen {
		return fmt.Errorf("vault: use a passphrase of %d to %d characters", MinPassphraseLen, maxPassphraseLen)
	}
	f.mu.Lock()
	file := f.file
	f.mu.Unlock()
	if file == nil {
		return f.create(func(key []byte) (wrappedKey, error) { return wrapWithPassphrase(passphrase, key, f.iterations) })
	}
	if file.Key.Source != sourcePassphrase {
		return errNoPassphrase
	}
	key, err := unwrapWithPassphrase(passphrase, file.Key)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.key = key
	return nil
}

// Each passphrase vault is made with a random salt, which it keeps.
func passphraseFingerprint(salt string) string {
	sum := sha256.Sum256([]byte(fileFingerprintInfo + "\x00" + salt))
	return hex.EncodeToString(sum[:16])
}

func (f *FileVault) create(wrap func(key []byte) (wrappedKey, error)) error {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return err
	}
	wrapped, err := wrap(key)
	if err != nil {
		return err
	}
	file := &vaultFile{V: fileVaultVersion, Key: wrapped, Items: map[string]fileItem{}}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.file != nil {
		return errors.New("vault: the key vault was made meanwhile")
	}
	if err := f.saveLocked(file); err != nil && !errors.Is(err, errNotSynced) {
		return err
	}
	f.file, f.key = file, key
	return nil
}

func (f *FileVault) Put(id string, value []byte, binding string) error {
	if !idPattern.MatchString(id) || !bindingPattern.MatchString(binding) {
		return fmt.Errorf("key vault: store %s: invalid item (%w)", id, errUnchanged)
	}
	if len(value) == 0 || len(value) > maxValueLen {
		return fmt.Errorf("key vault: store %s: want 1-%d bytes (%w)", id, maxValueLen, errUnchanged)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key == nil {
		return fmt.Errorf("%w (%w)", ErrLocked, errUnchanged)
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("key vault: store %s: %w (%w)", id, err, errUnchanged)
	}
	aead, err := newGCM(f.key)
	if err != nil {
		return fmt.Errorf("key vault: store %s: %w (%w)", id, err, errUnchanged)
	}
	next := *f.file
	next.Items = maps.Clone(f.file.Items)
	next.Items[id] = fileItem{
		Binding: binding,
		Nonce:   b64.EncodeToString(nonce),
		CT:      b64.EncodeToString(aead.Seal(nil, nonce, value, itemAAD(id, binding))),
	}
	if err := f.saveLocked(&next); err != nil {
		if errors.Is(err, errNotSynced) {
			f.file = &next
			return err
		}
		return fmt.Errorf("key vault: store %s: %w (%w)", id, err, errUnchanged)
	}
	f.file = &next
	return nil
}

func (f *FileVault) Get(id, binding string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key == nil {
		return nil, ErrLocked
	}
	item, ok := f.file.Items[id]
	if !ok {
		return nil, ErrNotFound
	}
	if item.Binding != binding {
		return nil, fmt.Errorf("key vault: item %s: %w", id, ErrRebound)
	}
	nonce, err1 := b64.DecodeString(item.Nonce)
	ct, err2 := b64.DecodeString(item.CT)
	aead, err3 := newGCM(f.key)
	if err := errors.Join(err1, err2, err3); err != nil || len(nonce) != 12 {
		return nil, fmt.Errorf("key vault: item %s is damaged; store it again", id)
	}
	value, err := aead.Open(nil, nonce, ct, itemAAD(id, binding))
	if err != nil {
		return nil, fmt.Errorf("key vault: item %s does not open; store it again", id)
	}
	return value, nil
}

func (f *FileVault) Delete(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key == nil {
		return ErrLocked
	}
	if _, ok := f.file.Items[id]; !ok {
		return ErrNotFound
	}
	next := *f.file
	next.Items = maps.Clone(f.file.Items)
	delete(next.Items, id)
	if err := f.saveLocked(&next); err != nil && !errors.Is(err, errNotSynced) {
		return err
	}
	f.file = &next
	return nil
}

func (f *FileVault) forgetAll() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.key == nil {
		return ErrLocked
	}
	next := *f.file
	next.Items = map[string]fileItem{}
	if err := f.saveLocked(&next); err != nil && !errors.Is(err, errNotSynced) {
		return err
	}
	f.file = &next
	return nil
}

func (f *FileVault) saveLocked(file *vaultFile) error {
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return f.write(f.path, data)
}

func itemAAD(id, binding string) []byte {
	return []byte(fileItemInfo + "\x00" + id + "\x00" + binding)
}

func keyAAD(k wrappedKey) []byte {
	return []byte(fileKeyInfo + "\x00" + k.KDF + "\x00" + strconv.Itoa(k.Iterations) + "\x00" + k.Salt)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func wrapWithCredentials(creds Credentials, key []byte) (wrappedKey, error) {
	plain := []byte(hex.EncodeToString(key))
	defer clear(plain)
	sealed, err := creds.Encrypt(plain)
	if err != nil {
		return wrappedKey{}, err
	}
	return wrappedKey{Source: sourceCredentials, TPM: creds.TPM(), Credential: base64.StdEncoding.EncodeToString(sealed)}, nil
}

func wrapWithPassphrase(passphrase, key []byte, iterations int) (wrappedKey, error) {
	salt := make([]byte, 16)
	nonce := make([]byte, 12)
	if _, err := rand.Read(salt); err != nil {
		return wrappedKey{}, err
	}
	if _, err := rand.Read(nonce); err != nil {
		return wrappedKey{}, err
	}
	k := wrappedKey{Source: sourcePassphrase, KDF: kdfPBKDF2, Iterations: iterations, Salt: b64.EncodeToString(salt), Nonce: b64.EncodeToString(nonce)}
	kek, err := pbkdf2.Key(sha256.New, string(passphrase), salt, iterations, 32)
	if err != nil {
		return wrappedKey{}, err
	}
	defer clear(kek)
	aead, err := newGCM(kek)
	if err != nil {
		return wrappedKey{}, err
	}
	k.Wrapped = b64.EncodeToString(aead.Seal(nil, nonce, key, keyAAD(k)))
	return k, nil
}

func unwrapWithPassphrase(passphrase []byte, k wrappedKey) ([]byte, error) {
	salt, err1 := b64.DecodeString(k.Salt)
	nonce, err2 := b64.DecodeString(k.Nonce)
	wrapped, err3 := b64.DecodeString(k.Wrapped)
	if err := errors.Join(err1, err2, err3); err != nil || len(nonce) != 12 {
		return nil, errors.New("vault: the key vault's wrapped key is damaged")
	}
	kek, err := pbkdf2.Key(sha256.New, string(passphrase), salt, k.Iterations, 32)
	if err != nil {
		return nil, err
	}
	defer clear(kek)
	aead, err := newGCM(kek)
	if err != nil {
		return nil, err
	}
	key, err := aead.Open(nil, nonce, wrapped, keyAAD(k))
	if err != nil || len(key) != 32 {
		return nil, ErrPassphrase
	}
	return key, nil
}
