package vault

import (
	"os"
	"testing"
)

func TestPushKeyIDIsNotWritable(t *testing.T) {
	store := NewMemory()
	v, _ := openTemp(t, store)
	if err := v.Put(httpRecord(PushKeyID), fakeValue); err == nil {
		t.Fatal("a user secret must not take the push key's item")
	}
	if _, err := store.Get(PushKeyID, bindingOf(httpRecord(PushKeyID))); err == nil {
		t.Fatal("nothing may be written for a refused id")
	}
	if Writable(PushKeyID) || !Writable("weather") || Writable("ollama") {
		t.Fatal("Writable must refuse the push key id and reserved ids only")
	}
}

func TestAnIndexThatAlreadyNamesThePushKeyStillOpens(t *testing.T) {
	_, path := openTemp(t, NewMemory())
	index := `{"v":1,"secrets":[{"id":"webpush-vapid","kind":"http","hosts":["api.example.test"],"header":"X-Api-Key","format":"raw","createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}]}`
	if err := os.WriteFile(path, []byte(index), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := Open(NewMemory(), path)
	if err != nil {
		t.Fatalf("an older index must still open: %v", err)
	}
	if _, ok := v.Record(PushKeyID); !ok {
		t.Fatal("the user's record stays visible so they can remove it")
	}
}
