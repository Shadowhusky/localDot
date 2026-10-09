package webpush

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

var fixedNow = func() time.Time { return time.Unix(1_800_000_000, 0) }

func never(string) bool { return false }

func verifyJWT(t *testing.T, token, publicKey string) map[string]any {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("want three JWT parts, got %d", len(parts))
	}
	header, _ := base64.RawURLEncoding.DecodeString(parts[0])
	if string(header) != `{"typ":"JWT","alg":"ES256"}` {
		t.Fatalf("header %s", header)
	}
	raw, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), raw)
	if err != nil {
		t.Fatal(err)
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	if len(sig) != 64 {
		t.Fatalf("want a 64-byte r||s signature, got %d", len(sig))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("the token does not verify against the public key")
	}
	body, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var claims map[string]any
	if err := json.Unmarshal(body, &claims); err != nil {
		t.Fatal(err)
	}
	return claims
}

func TestSignVAPIDVerifiesAgainstPublicKey(t *testing.T) {
	s := NewSigner(vault.NewMemory(), never, fixedNow)
	token, err := s.SignVAPID("https://web.push.apple.com")
	if err != nil {
		t.Fatal(err)
	}
	pub, err := s.PublicKey()
	if err != nil {
		t.Fatal(err)
	}
	claims := verifyJWT(t, token, pub)
	if claims["aud"] != "https://web.push.apple.com" || claims["sub"] != Subject {
		t.Fatalf("claims %v", claims)
	}
	if exp := int64(claims["exp"].(float64)); exp != fixedNow().Add(time.Hour).Unix() {
		t.Fatalf("exp %d", exp)
	}
}

func TestKeySurvivesRestartInTheStore(t *testing.T) {
	store := vault.NewMemory()
	first, _ := NewSigner(store, never, fixedNow).PublicKey()
	second, err := NewSigner(store, never, fixedNow).PublicKey()
	if err != nil || first != second || len(first) != 87 {
		t.Fatalf("first %q second %q err %v", first, second, err)
	}
}

func TestDamagedKeyFailsClosedAndIsKept(t *testing.T) {
	store := vault.NewMemory()
	store.Put(StoreID, []byte("not-a-key"), keyBinding)
	if _, err := NewSigner(store, never, fixedNow).PublicKey(); !errors.Is(err, ErrKeyDamaged) {
		t.Fatalf("want ErrKeyDamaged, got %v", err)
	}
	if kept, _ := store.Get(StoreID, keyBinding); string(kept) != "not-a-key" {
		t.Fatal("an unreadable key must never be replaced")
	}
}

func TestUserSecretWithTheSameNameBlocksTheKey(t *testing.T) {
	store := vault.NewMemory()
	userBinding := strings.Repeat("ab", 32)
	store.Put(StoreID, []byte("users-own-secret-value"), userBinding)
	s := NewSigner(store, func(id string) bool { return id == StoreID }, fixedNow)
	if _, err := s.SignVAPID("https://web.push.apple.com"); !errors.Is(err, ErrKeyBlocked) {
		t.Fatalf("want ErrKeyBlocked, got %v", err)
	}
	if kept, _ := store.Get(StoreID, userBinding); string(kept) != "users-own-secret-value" {
		t.Fatal("the user's secret must be untouched")
	}
}
