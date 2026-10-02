### Task 3: Sealed intake — the daemon relays a key it cannot read

Trust rule 3, as amended after review 1: the daemon never sees a plaintext secret, because the key
form in the UI seals the key to keyd and the daemon only relays the ciphertext. keyd's only doors
are its 0600 admin socket and the per-cell listeners, and a browser can reach neither, so the UI
seals the key to keyd's per-boot key (P4a-R2): ECDH P-256 with an ephemeral key, HKDF-SHA256 over
the shared secret, AES-256-GCM with the secret's whole binding in the AAD — id, kind, provider, base
URL, hosts, header, format, methods and paths, as a JSON array — so a value captured within one
boot cannot be replayed under another binding (review 1, M6). Every step is in WebCrypto. The daemon
relays ciphertext. keyd's key pair is made per process and never written anywhere. The test
includes two blobs sealed by Node 25's WebCrypto with the exact snippet in "Interfaces Part 4b
builds on", one with lists and an `&` in a path, so the two implementations, and their two JSON
encoders, are pinned to each other.

**Files:**
- Create: `keyd/internal/vault/seal.go`
- Test: `keyd/internal/vault/seal_test.go`

**Interfaces:**
- Consumes: `fakeValue` from `vault_test.go` (Task 2).
- Produces: `Sealed{V int; EPK, Nonce, CT string}` (JSON `v epk nonce ct`, base64url without
  padding), `NewOpener() (*Opener, error)`, `(*Opener).PublicKey() string` (uncompressed P-256
  point, base64url), `(*Opener).Open(s Sealed, rec Record) ([]byte, error)`,
  `Seal(publicKey string, rec Record, plaintext []byte) (Sealed, error)`; the AAD is
  `localdot-keyd seal v1:` followed by the JSON array `[id, kind, provider, baseURL, hosts, header,
  format, methods, paths]`, `""` and `[]` for what is absent, without HTML escaping.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/vault/seal_test.go`:
```go
package vault

import (
	"crypto/ecdh"
	"encoding/hex"
	"slices"
	"testing"
)

var weatherRecord = Record{ID: "weather", Kind: KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}

func TestSealOpenRoundTrip(t *testing.T) {
	o, err := NewOpener()
	if err != nil {
		t.Fatal(err)
	}
	s, err := Seal(o.PublicKey(), weatherRecord, fakeValue)
	if err != nil {
		t.Fatal(err)
	}
	got, err := o.Open(s, weatherRecord)
	if err != nil || string(got) != string(fakeValue) {
		t.Fatalf("Open = %q, %v", got, err)
	}
}

func TestOpenRefusesAnotherBindingKeyOrBytes(t *testing.T) {
	o, _ := NewOpener()
	other, _ := NewOpener()
	good, _ := Seal(o.PublicKey(), weatherRecord, fakeValue)
	changed := func(edit func(*Sealed)) Sealed {
		s := good
		edit(&s)
		return s
	}
	rebound := func(edit func(*Record)) Record {
		r := weatherRecord
		r.Hosts = slices.Clone(r.Hosts)
		edit(&r)
		return r
	}
	ct, _ := b64.DecodeString(good.CT)
	ct[0] ^= 1
	flipped := b64.EncodeToString(ct)
	cases := []struct {
		name   string
		sealed Sealed
		opener *Opener
		rec    Record
	}{
		{"other secret id", good, o, rebound(func(r *Record) { r.ID = "openai" })},
		{"other hosts", good, o, rebound(func(r *Record) { r.Hosts = []string{"evil.example.test"} })},
		{"a host added", good, o, rebound(func(r *Record) { r.Hosts = append(r.Hosts, "evil.example.test") })},
		{"other header", good, o, rebound(func(r *Record) { r.Header = "X-Api-Key" })},
		{"other format", good, o, rebound(func(r *Record) { r.Format = "raw" })},
		{"other recipient", good, other, weatherRecord},
		{"tampered ciphertext", changed(func(s *Sealed) { s.CT = flipped }), o, weatherRecord},
		{"bad version", changed(func(s *Sealed) { s.V = 2 }), o, weatherRecord},
		{"short nonce", changed(func(s *Sealed) { s.Nonce = "AAAA" }), o, weatherRecord},
		{"bad point", changed(func(s *Sealed) { s.EPK = "BAAA" }), o, weatherRecord},
		{"not base64", changed(func(s *Sealed) { s.CT = "***" }), o, weatherRecord},
	}
	for _, c := range cases {
		if _, err := c.opener.Open(c.sealed, c.rec); err == nil {
			t.Errorf("%s: Open succeeded", c.name)
		}
	}
	limited, _ := Seal(o.PublicKey(), rebound(func(r *Record) { r.Methods = []string{"GET"} }), fakeValue)
	if _, err := o.Open(limited, weatherRecord); err == nil {
		t.Error("a value sealed with a method limit opened without it")
	}
}

// Sealed with Node 25's WebCrypto (the snippet in the plan's interface notes) to the fixed key below.
func TestOpenAcceptsWhatWebCryptoSeals(t *testing.T) {
	scalar, _ := hex.DecodeString("6b1f3c2a9d8e7f60514233241506f7e8d9cabbac9d8e7f6051423324150617f8")
	priv, err := ecdh.P256().NewPrivateKey(scalar)
	if err != nil {
		t.Fatal(err)
	}
	o := &Opener{priv: priv}
	if o.PublicKey() != "BG2x8-BG3l6OwZSDEY2jv15f49mKcudyq5wvNeAMGomjt95F3U2ihX3pW1kqXeAogtDMs6rhGvlhvnCeU3XFwgM" {
		t.Fatalf("PublicKey = %s", o.PublicKey())
	}
	cases := []struct {
		rec    Record
		sealed Sealed
	}{
		{
			Record{ID: "anthropic", Kind: KindLLM, Provider: "anthropic"},
			Sealed{
				V:     1,
				EPK:   "BDRBSHmompILZT4JXnwFw_aLRlQBykzXvyaBUZKuUZHkfbY1Hi_0x2xLVFEhKRT3RBSwEKdH7ofgaQaMkb1E_-4",
				Nonce: "RcWTiYUMWlwdbPpo",
				CT:    "eSbQx0PjBEKB5huMwBy6TF0BeOiziJjeNgrtcGcDXzKjeAqbRAcR",
			},
		},
		{
			Record{ID: "weather", Kind: KindHTTP, Hosts: []string{"api.example.test", "b.example.test"}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{"/v1/a&b/"}},
			Sealed{
				V:     1,
				EPK:   "BCghCEuuHBof4xoiFZ9-spP370ghtOh8IKmtP_zyqo34vqD9IbiojExBy3YylZssk48g6qJiST45EKz289oeRzY",
				Nonce: "FgtfN8Eg8teW7BSf",
				CT:    "G_0PaqZmmO-YCxm4CHC4lqox8u2JRzw7GckBNM6B3LCBKr0Ywfqk",
			},
		},
	}
	for _, c := range cases {
		got, err := o.Open(c.sealed, c.rec)
		if err != nil || string(got) != "fake-key-from-webcrypto" {
			t.Errorf("%s: Open = %q, %v", c.rec.ID, got, err)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/vault/`
Expected: FAIL — `[build failed]`, starting `internal/vault/seal_test.go:13:12: undefined: NewOpener`.

- [ ] **Step 3: Implement sealing**

`keyd/internal/vault/seal.go`:
```go
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
	"encoding/json"
	"errors"
	"fmt"
)

// The seal scheme lets the UI encrypt a key to keyd so that the daemon relaying it never holds
// the plaintext: ECDH P-256 with an ephemeral sender key, HKDF-SHA256 over the shared secret
// (salt = sender public key || keyd public key), AES-256-GCM with the secret's binding in the AAD.
// WebCrypto can produce it with ECDH deriveBits, HKDF deriveKey and AES-GCM encrypt.
const sealInfo = "localdot-keyd seal v1"

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
	plain, err := aead.Open(nil, nonce, ct, sealAAD(rec))
	if err != nil {
		return nil, errSealed
	}
	return plain, nil
}

// Seal encrypts plaintext for rec to the holder of publicKey, as the UI does.
func Seal(publicKey string, rec Record, plaintext []byte) (Sealed, error) {
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
	ct := aead.Seal(nil, nonce, plaintext, sealAAD(rec))
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

// sealAAD binds a sealed value to its record: the id and every field that says where the secret
// may go, as the JSON array [id, kind, provider, baseURL, hosts, header, format, methods, paths]
// with "" and [] for what is absent, which JSON.stringify writes byte for byte the same.
func sealAAD(rec Record) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.Encode([]any{rec.ID, rec.Kind, rec.Provider, rec.BaseURL, list(rec.Hosts), rec.Header, rec.Format, list(rec.Methods), list(rec.Paths)})
	return append([]byte(sealInfo+":"), bytes.TrimSuffix(buf.Bytes(), []byte("\n"))...)
}

func list(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/vault/`
Expected: `ok` (15 tests, one skipped).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/vault
git commit -m "feat(keyd): sealed secret intake"
```

---
