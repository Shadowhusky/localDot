package vault

import (
	"crypto/ecdh"
	"encoding/hex"
	"errors"
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
		{"off-curve point", changed(func(s *Sealed) { s.EPK = b64.EncodeToString(append([]byte{4}, make([]byte, 64)...)) }), o, weatherRecord},
		{"not base64", changed(func(s *Sealed) { s.CT = "***" }), o, weatherRecord},
	}
	for _, c := range cases {
		_, err := c.opener.Open(c.sealed, c.rec)
		switch {
		case err == nil:
			t.Errorf("%s: Open succeeded", c.name)
		case c.sealed.V == 1 && !errors.Is(err, errSealed):
			t.Errorf("%s: %v, want the uniform error", c.name, err)
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
