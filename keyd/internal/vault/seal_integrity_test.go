package vault

import (
	"errors"
	"testing"
)

func TestSealUsesAFreshKeyAndNonce(t *testing.T) {
	o, err := NewOpener()
	if err != nil {
		t.Fatal(err)
	}
	a, err1 := Seal(o.PublicKey(), weatherRecord, fakeValue)
	b, err2 := Seal(o.PublicKey(), weatherRecord, fakeValue)
	if err := errors.Join(err1, err2); err != nil {
		t.Fatal(err)
	}
	if a.EPK == b.EPK || a.Nonce == b.Nonce {
		t.Fatalf("two seals share a key or a nonce:\n%+v\n%+v", a, b)
	}
}

// Neither WebCrypto vector has a base URL, which decides where an openai-compatible or azure key
// goes.
func TestOpenRefusesAnotherBaseURL(t *testing.T) {
	o, err := NewOpener()
	if err != nil {
		t.Fatal(err)
	}
	rec := Record{ID: "gateway", Kind: KindLLM, Provider: "openai-compatible", BaseURL: "https://llm.example.test/v1"}
	s, err := Seal(o.PublicKey(), rec, fakeValue)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := o.Open(s, rec); err != nil {
		t.Fatal(err)
	}
	rec.BaseURL = "https://evil.example.test/v1"
	if _, err := o.Open(s, rec); err == nil {
		t.Fatal("a value sealed for one base URL opened for another")
	}
}
