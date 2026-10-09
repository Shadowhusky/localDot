// Package webpush signs VAPID tokens with a P-256 key kept in keyd's secret store and sends
// encrypted Web Push messages to the browser vendors' push services, and nowhere else.
package webpush

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// StoreID names the Keychain item that holds the VAPID private key. vault.Put refuses it, so no
// key the user adds can take its place.
const StoreID = vault.PushKeyID

// Subject is the contact the push services see in every token.
const Subject = "https://github.com/shadowhusky/localdot"

const tokenLife = time.Hour

// keyBinding is what the store keeps beside the key. A user secret's binding digests a JSON array,
// so it can never equal this one.
var keyBinding = func() string {
	sum := sha256.Sum256([]byte("localdot-keyd push key v1"))
	return hex.EncodeToString(sum[:])
}()

var (
	ErrKeyBlocked = errors.New("webpush: a key named webpush-vapid is in the way")
	ErrKeyDamaged = errors.New("webpush: the stored push key is unreadable")
)

type Signer struct {
	store vault.Store
	taken func(id string) bool
	now   func() time.Time
	mu    sync.Mutex
	key   *ecdsa.PrivateKey
}

// NewSigner keeps its key in store. taken reports whether a user secret already uses StoreID.
func NewSigner(store vault.Store, taken func(id string) bool, now func() time.Time) *Signer {
	return &Signer{store: store, taken: taken, now: now}
}

// PublicKey is the uncompressed P-256 point, base64url: a browser's applicationServerKey.
func (s *Signer) PublicKey() (string, error) {
	key, err := s.load()
	if err != nil {
		return "", err
	}
	raw, err := key.PublicKey.Bytes()
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

// SignVAPID makes the RFC 8292 token for one push service origin. It never leaves keyd.
func (s *Signer) SignVAPID(audience string) (string, error) {
	key, err := s.load()
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"JWT","alg":"ES256"}`))
	claims, err := json.Marshal(map[string]any{
		"aud": audience,
		"exp": s.now().Add(tokenLife).Unix(),
		"sub": Subject,
	})
	if err != nil {
		return "", err
	}
	input := header + "." + base64.RawURLEncoding.EncodeToString(claims)
	digest := sha256.Sum256([]byte(input))
	r, sig, err := ecdsa.Sign(rand.Reader, key, digest[:])
	if err != nil {
		return "", err
	}
	raw := make([]byte, 64)
	r.FillBytes(raw[:32])
	sig.FillBytes(raw[32:])
	return input + "." + base64.RawURLEncoding.EncodeToString(raw), nil
}

// load reads the key once, or makes and stores one. An item that is present but unreadable stays:
// replacing it would silently break every phone that subscribed with the old key.
func (s *Signer) load() (*ecdsa.PrivateKey, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key != nil {
		return s.key, nil
	}
	if s.taken(StoreID) {
		return nil, ErrKeyBlocked
	}
	stored, err := s.store.Get(StoreID, keyBinding)
	switch {
	case err == nil:
		defer clear(stored)
		scalar, derr := base64.RawURLEncoding.DecodeString(string(stored))
		if derr != nil || len(scalar) != 32 {
			return nil, ErrKeyDamaged
		}
		defer clear(scalar)
		key, perr := ecdsa.ParseRawPrivateKey(elliptic.P256(), scalar)
		if perr != nil {
			return nil, ErrKeyDamaged
		}
		s.key = key
	case errors.Is(err, vault.ErrNotFound):
		key, gerr := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if gerr != nil {
			return nil, gerr
		}
		scalar, berr := key.Bytes()
		if berr != nil {
			return nil, berr
		}
		value := []byte(base64.RawURLEncoding.EncodeToString(scalar))
		clear(scalar)
		defer clear(value)
		if perr := s.store.Put(StoreID, value, keyBinding); perr != nil {
			return nil, perr
		}
		s.key = key
	default:
		return nil, err
	}
	return s.key, nil
}
