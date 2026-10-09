package vault

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
)

// The seal scheme lets the UI encrypt a key to keyd so that the daemon relaying it never holds
// the plaintext: ECDH P-256 with an ephemeral sender key, HKDF-SHA256 over the shared secret
// (salt = sender public key || keyd public key), AES-256-GCM with the secret's binding in the AAD.
// WebCrypto can produce it with ECDH deriveBits, HKDF deriveKey and AES-GCM encrypt.
const (
	sealInfo    = "localdot-keyd seal v1"
	bindingInfo = "localdot-keyd binding v1"
)

var errSealed = errors.New("vault: cannot open the sealed secret")

// Sealed is the JSON a client posts; every field is base64url without padding.
type Sealed struct {
	V     int    `json:"v"`
	EPK   string `json:"epk"`
	Nonce string `json:"nonce"`
	CT    string `json:"ct"`
}

// Opener holds keyd's seal key pair, generated per process and never written anywhere.
type Opener struct {
	priv *ecdh.PrivateKey
}

func NewOpener() (*Opener, error) {
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &Opener{priv: priv}, nil
}

// PublicKey is keyd's public key as an uncompressed P-256 point in base64url.
func (o *Opener) PublicKey() string {
	return b64.EncodeToString(o.priv.PublicKey().Bytes())
}

// Open decrypts a value sealed for rec: a blob sealed for another id or binding does not open.
func (o *Opener) Open(s Sealed, rec Record) ([]byte, error) {
	return o.open(s, sealAAD(rec))
}

// OpenPassphrase decrypts a key vault passphrase. Its AAD is no record's, so a sealed secret never
// opens as a passphrase, nor a passphrase as a secret.
func (o *Opener) OpenPassphrase(s Sealed) ([]byte, error) {
	return o.open(s, []byte(passphraseAAD))
}

const passphraseAAD = sealInfo + ":vault-passphrase"

func (o *Opener) open(s Sealed, aad []byte) ([]byte, error) {
	if s.V != 1 {
		return nil, fmt.Errorf("vault: sealed version %d, want 1", s.V)
	}
	epkBytes, err1 := b64.DecodeString(s.EPK)
	nonce, err2 := b64.DecodeString(s.Nonce)
	ct, err3 := b64.DecodeString(s.CT)
	if err := errors.Join(err1, err2, err3); err != nil || len(nonce) != 12 {
		return nil, errSealed
	}
	epk, err := ecdh.P256().NewPublicKey(epkBytes)
	if err != nil {
		return nil, errSealed
	}
	aead, err := sealAEAD(o.priv, epk, epkBytes, o.priv.PublicKey().Bytes())
	if err != nil {
		return nil, errSealed
	}
	plain, err := aead.Open(nil, nonce, ct, aad)
	if err != nil {
		return nil, errSealed
	}
	return plain, nil
}

// Seal encrypts plaintext for rec to the holder of publicKey, as the UI does.
func Seal(publicKey string, rec Record, plaintext []byte) (Sealed, error) {
	return seal(publicKey, sealAAD(rec), plaintext)
}

// SealPassphrase encrypts a key vault passphrase to the holder of publicKey, as the CLI does.
func SealPassphrase(publicKey string, passphrase []byte) (Sealed, error) {
	return seal(publicKey, []byte(passphraseAAD), passphrase)
}

func seal(publicKey string, aad, plaintext []byte) (Sealed, error) {
	recipientBytes, err := b64.DecodeString(publicKey)
	if err != nil {
		return Sealed{}, err
	}
	recipient, err := ecdh.P256().NewPublicKey(recipientBytes)
	if err != nil {
		return Sealed{}, err
	}
	eph, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return Sealed{}, err
	}
	aead, err := sealAEAD(eph, recipient, eph.PublicKey().Bytes(), recipientBytes)
	if err != nil {
		return Sealed{}, err
	}
	nonce := make([]byte, 12)
	if _, err := rand.Read(nonce); err != nil {
		return Sealed{}, err
	}
	ct := aead.Seal(nil, nonce, plaintext, aad)
	return Sealed{V: 1, EPK: b64.EncodeToString(eph.PublicKey().Bytes()), Nonce: b64.EncodeToString(nonce), CT: b64.EncodeToString(ct)}, nil
}

var b64 = base64.RawURLEncoding

func sealAEAD(priv *ecdh.PrivateKey, peer *ecdh.PublicKey, senderPub, recipientPub []byte) (cipher.AEAD, error) {
	shared, err := priv.ECDH(peer)
	if err != nil {
		return nil, err
	}
	salt := append(append([]byte{}, senderPub...), recipientPub...)
	key, err := hkdf.Key(sha256.New, shared, salt, sealInfo, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// sealAAD binds a sealed value to its record (see bindingFields).
func sealAAD(rec Record) []byte {
	return append([]byte(sealInfo+":"), bindingFields(rec)...)
}

// bindingFields is the id and every field that says where the secret may go, as the JSON array
// [id, kind, provider, baseURL, hosts, header, format, methods, paths] with "" and [] for what is
// absent. JSON.stringify writes the same bytes except at U+2028 and U+2029, which Go escapes and it
// does not, so a seal over a record holding either never opens: it fails closed.
func bindingFields(rec Record) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode([]any{rec.ID, rec.Kind, rec.Provider, rec.BaseURL, list(rec.Hosts), rec.Header, rec.Format, list(rec.Methods), list(rec.Paths)})
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
}

// bindingOf is what the store keeps beside rec's value: a digest of rec's binding, which the
// index cannot change without the value refusing to read.
func bindingOf(rec Record) string {
	sum := sha256.Sum256(append([]byte(bindingInfo+":"), bindingFields(rec)...))
	return hex.EncodeToString(sum[:])
}

func list(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}
