package vault

import (
	"errors"
	"path/filepath"
	"testing"
)

func TestMetadataDoesNotChangeStoredBindingOrReadValue(t *testing.T) {
	store := NewMemory()
	path := filepath.Join(t.TempDir(), "index.json")
	v, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	rec := httpRecord("weather")
	if err = v.Put(rec, []byte("synthetic-value-123")); err != nil {
		t.Fatal(err)
	}
	before, _ := v.Record(rec.ID)
	if err = v.SetMetadata(rec.ID, Metadata{Label: "天气", Service: "Weather", Description: "Hourly forecast"}); err != nil {
		t.Fatal(err)
	}
	after, _ := v.Record(rec.ID)
	if bindingOf(before) != bindingOf(after) {
		t.Fatal("description changed binding")
	}
	reopened, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	persisted, _ := reopened.Record(rec.ID)
	if persisted.Metadata.Label != "天气" {
		t.Fatal("lost metadata")
	}
	got, err := reopened.Value(rec.ID)
	if err != nil || string(got) != "synthetic-value-123" {
		t.Fatal("lost stored value")
	}
	persisted.Metadata.Label = "mutated"
	current, _ := reopened.Record(rec.ID)
	if current.Metadata.Label != "天气" {
		t.Fatal("metadata alias")
	}
	if err = reopened.SetMetadata("missing", Metadata{}); !errors.Is(err, ErrNotFound) {
		t.Fatal("created metadata for missing key")
	}
	if err = reopened.SetMetadata(rec.ID, Metadata{Label: "line\nbreak"}); err == nil {
		t.Fatal("accepted controls")
	}
}
