package vault

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
)

// A Put whose index cannot be saved must leave the old record and value in force, in memory and in
// the store, so an error means nothing changed. The index's parent is a regular file, which fails
// the save even for root. The cold vault has not read the value yet, so only the store can serve it.
func TestAFailedPutChangesNothing(t *testing.T) {
	store := NewMemory()
	warm, path := openTemp(t, store)
	if err := warm.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	cold, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	rotated := httpRecord("weather")
	rotated.Hosts = []string{"new-host.example.test"}
	for name, v := range map[string]*Vault{"warm": warm, "cold": cold} {
		v.path = filepath.Join(blocker, "secrets.json")
		if err := v.Put(rotated, []byte("rotated-fake-value-for-test")); err == nil {
			t.Fatalf("%s: Put succeeded without saving the index", name)
		}
		rec, _ := v.Record("weather")
		got, err := v.Value("weather")
		stored, _ := store.Get("weather")
		if rec.Hosts[0] != "api.example.test" || err != nil || !bytes.Equal(got, fakeValue) || !bytes.Equal(stored, fakeValue) {
			t.Errorf("%s: after a failed Put the hosts are %v, the value %q (%v), the store %q", name, rec.Hosts, got, err, stored)
		}
		if err := v.Put(httpRecord("fresh"), fakeValue); err == nil {
			t.Fatalf("%s: Put of a new secret succeeded without saving the index", name)
		}
		if _, ok := v.Record("fresh"); ok {
			t.Errorf("%s: a new record outlived its failed Put", name)
		}
		if _, err := store.Get("fresh"); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s: a new value outlived its failed Put: %v", name, err)
		}
	}
}

// In a directory keyd may write but not read, the rename lands and only the directory sync
// fails: the Put must fail and put the old index back. Root reads any directory, so it skips.
func TestAFailedDirectorySyncPutsTheOldIndexBack(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root can read the directory")
	}
	store := NewMemory()
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(path)
	if err := os.Chmod(dir, 0o300); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chmod(dir, 0o700) })
	rotated := httpRecord("weather")
	rotated.Hosts = []string{"new-host.example.test"}
	if err := v.Put(rotated, []byte("rotated-fake-value-for-test")); err == nil {
		t.Fatal("Put succeeded without syncing the index's directory")
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	disk, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	if rec, _ := disk.Record("weather"); rec.Hosts[0] != "api.example.test" {
		t.Fatalf("after the failed Put the index holds the hosts %v", rec.Hosts)
	}
}

func TestRecordsAreCopiedInAndOut(t *testing.T) {
	v, _ := Open(NewMemory(), "")
	rec := httpRecord("weather")
	rec.Methods, rec.Paths = []string{"GET"}, []string{"/v1/"}
	if err := v.Put(rec, fakeValue); err != nil {
		t.Fatal(err)
	}
	rec.Hosts[0], rec.Methods[0], rec.Paths[0] = "caller.example.test", "DELETE", "/admin/"
	got, _ := v.Record("weather")
	got.Hosts[0], got.Methods[0], got.Paths[0] = "reader.example.test", "PUT", "/admin/"
	listed := v.Records()
	listed[0].Hosts[0], listed[0].Methods[0], listed[0].Paths[0] = "lister.example.test", "PATCH", "/admin/"
	final, _ := v.Record("weather")
	if final.Hosts[0] != "api.example.test" || final.Methods[0] != "GET" || final.Paths[0] != "/v1/" {
		t.Fatalf("a copy changed the vault's record: %+v", final)
	}
}

// Run with -race: callers edit the records they get while other calls save the index. Every
// goroutine ends on those edits, so a record they reach is caught even without -race.
func TestConcurrentUseKeepsMemoryAndIndexInStep(t *testing.T) {
	store := NewMemory()
	v, path := openTemp(t, store)
	var wg sync.WaitGroup
	for g := range 6 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("s%d", g%3)
			for i := range 60 {
				switch i % 6 {
				case 0, 3:
					_ = v.Put(httpRecord(id), fakeValue)
				case 1:
					_, _ = v.Value(id)
				case 2:
					_ = v.Delete(id)
				case 4:
					if r, ok := v.Record(id); ok {
						r.Hosts[0] = "edited.example.test"
					}
				case 5:
					for _, r := range v.Records() {
						r.Hosts[0] = "edited.example.test"
					}
				}
			}
		}()
	}
	wg.Wait()
	disk, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	mem, saved := v.Records(), disk.Records()
	if len(mem) != len(saved) {
		t.Fatalf("%d records in memory, %d in the index", len(mem), len(saved))
	}
	for i, r := range mem {
		if r.ID != saved[i].ID || r.Hosts[0] != "api.example.test" || saved[i].Hosts[0] != "api.example.test" {
			t.Fatalf("memory holds %+v, the index %+v", r, saved[i])
		}
		if _, err := v.Value(r.ID); err != nil {
			t.Fatalf("record %s has no value: %v", r.ID, err)
		}
	}
}

func TestOpenRefusesAnIndexItCannotTrust(t *testing.T) {
	for name, index := range map[string]string{
		"unknown version": `{"v":2,"secrets":[]}`,
		"no version":      `{"secrets":[]}`,
		"reserved id":     `{"v":1,"secrets":[{"id":"ollama","kind":"llm"}]}`,
		"invalid id":      `{"v":1,"secrets":[{"id":"Bad ID","kind":"http"}]}`,
		"injected id":     `{"v":1,"secrets":[{"id":"x\ndelete-generic-password -a victim","kind":"http"}]}`,
		"unknown kind":    `{"v":1,"secrets":[{"id":"weather","kind":"weird"}]}`,
		"no kind":         `{"v":1,"secrets":[{"id":"weather"}]}`,
		"repeated id":     `{"v":1,"secrets":[{"id":"weather","kind":"http"},{"id":"weather","kind":"llm"}]}`,
	} {
		path := filepath.Join(t.TempDir(), "secrets.json")
		if err := os.WriteFile(path, []byte(index), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(NewMemory(), path); err == nil {
			t.Errorf("%s: Open succeeded", name)
		}
	}
}

func TestPutRejectsUnknownKinds(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	for _, kind := range []Kind{"", "weird", "LLM", "http "} {
		rec := httpRecord("weather")
		rec.Kind = kind
		if err := v.Put(rec, fakeValue); err == nil {
			t.Errorf("Put of kind %q succeeded", kind)
		}
	}
	if _, ok := v.Record("weather"); ok {
		t.Fatal("a rejected kind left a record")
	}
}

func TestRecordsAreSortedByID(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	ids := []string{"weather", "anthropic", "zeta", "maps", "0day", "b_2", "b-1", "openai"}
	for _, id := range ids {
		if err := v.Put(httpRecord(id), fakeValue); err != nil {
			t.Fatal(err)
		}
	}
	var got []string
	for _, r := range v.Records() {
		got = append(got, r.ID)
	}
	slices.Sort(ids)
	if !slices.Equal(got, ids) {
		t.Fatalf("Records() in the order %v, want %v", got, ids)
	}
}

func TestTheIndexHoldsNoCopyOfAValue(t *testing.T) {
	v, path := openTemp(t, NewMemory())
	values := map[string][]byte{"weather": longValue(64), "maps": longValue(100)}
	for id, value := range values {
		if err := v.Put(httpRecord(id), value); err != nil {
			t.Fatal(err)
		}
		if _, err := v.Value(id); err != nil {
			t.Fatal(err)
		}
	}
	index, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for id, value := range values {
		if copied(string(index), value) {
			t.Errorf("the index holds a copy of %s's value:\n%s", id, index)
		}
	}
}

// copied reports whether text carries value (see carries) or 16 characters of its base64, in
// either alphabet and at any byte alignment, as a []byte field would encode it.
func copied(text string, value []byte) bool {
	if carries(text, value) {
		return true
	}
	for skip := range 3 {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
			if strings.Contains(text, enc.EncodeToString(value[skip:])[:16]) {
				return true
			}
		}
	}
	return false
}
