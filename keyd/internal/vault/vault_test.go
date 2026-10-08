package vault

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var (
	fakeValue   = []byte("real-secret-value-for-test")
	testBinding = bindingOf(httpRecord("weather"))
)

func openTemp(t *testing.T, store Store) (*Vault, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "secrets.json")
	v, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	return v, path
}

func httpRecord(id string) Record {
	return Record{ID: id, Kind: KindHTTP, Hosts: []string{"api.example.test"}, Header: "X-Api-Key", Format: "raw"}
}

func TestPutStoresValueAndIndexWithoutTheValue(t *testing.T) {
	store := NewMemory()
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	got, err := v.Value("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value = %q, %v", got, err)
	}
	stored, _ := store.Get("weather", testBinding)
	if !bytes.Equal(stored, fakeValue) {
		t.Fatalf("store holds %q", stored)
	}
	index, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(index, fakeValue) {
		t.Fatal("the index file contains the secret value")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("index mode %v, want 0600", info.Mode().Perm())
	}
	rec, ok := v.Record("weather")
	if !ok || rec.CreatedAt.IsZero() || rec.Hosts[0] != "api.example.test" {
		t.Fatalf("Record = %+v, %v", rec, ok)
	}
}

func TestOpenReloadsTheIndex(t *testing.T) {
	store := NewMemory()
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	again, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	if recs := again.Records(); len(recs) != 1 || recs[0].ID != "weather" {
		t.Fatalf("Records = %+v", recs)
	}
	got, err := again.Value("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value after reopen = %q, %v", got, err)
	}
}

func TestPutRejectsBadIDsAndValues(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	for _, id := range []string{"", "Weather", "-x", "a b", strings.Repeat("a", 65), "lmstudio", "ollama"} {
		if err := v.Put(httpRecord(id), fakeValue); err == nil {
			t.Errorf("Put id %q succeeded", id)
		}
	}
	bad := [][]byte{
		nil,
		[]byte("short"),
		[]byte("has\nnewline-value"),
		[]byte(" leading-space-value"),
		[]byte("trailing-space-value "),
		[]byte("non-ascii-värde-value"),
		bytes.Repeat([]byte("a"), 8193),
	}
	for _, value := range bad {
		if err := v.Put(httpRecord("weather"), value); err == nil {
			t.Errorf("Put value %q succeeded", value)
		}
	}
	if _, ok := v.Record("weather"); ok {
		t.Fatal("a rejected Put left a record")
	}
}

func TestDeleteRemovesValueAndRecord(t *testing.T) {
	store := NewMemory()
	v, _ := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	if err := v.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Value("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Value after delete: %v", err)
	}
	if _, err := store.Get("weather", testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("store after delete: %v", err)
	}
	if err := v.Delete("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Delete: %v", err)
	}
}

func TestValueReadsTheStoreOnceThenCaches(t *testing.T) {
	store := &countingStore{Store: NewMemory()}
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	again, _ := Open(store, path)
	for range 3 {
		if _, err := again.Value("weather"); err != nil {
			t.Fatal(err)
		}
	}
	if store.gets != 1 {
		t.Fatalf("store read %d times, want 1", store.gets)
	}
}

func TestPutKeepsCreatedAtOnUpdate(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	first, _ := v.Record("weather")
	time.Sleep(2 * time.Millisecond)
	if err := v.Put(httpRecord("weather"), []byte("second-fake-value-for-test")); err != nil {
		t.Fatal(err)
	}
	second, _ := v.Record("weather")
	if !second.CreatedAt.Equal(first.CreatedAt) || !second.UpdatedAt.After(first.UpdatedAt) {
		t.Fatalf("times: first %+v second %+v", first, second)
	}
	got, _ := v.Value("weather")
	if string(got) != "second-fake-value-for-test" {
		t.Fatalf("Value = %q", got)
	}
}

func TestAnEmptyIndexPathKeepsEverythingInMemory(t *testing.T) {
	v, err := Open(NewMemory(), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	if got, err := v.Value("weather"); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value = %q, %v", got, err)
	}
	if err := v.Delete("weather"); err != nil {
		t.Fatal(err)
	}
}

type countingStore struct {
	Store
	gets int
}

func (c *countingStore) Get(id, binding string) ([]byte, error) {
	c.gets++
	return c.Store.Get(id, binding)
}
