package vault

import (
	"bytes"
	"errors"
	"sync"
	"testing"
	"time"
)

// heldStore holds the first call of an operation, once armed, until released. A held Get reads the
// value before it waits, as a Keychain read that stalls after finding its item would.
type heldStore struct {
	Store
	hold    string
	mu      sync.Mutex
	calls   int
	entered chan struct{}
	release chan struct{}
}

func newHeldStore(t *testing.T) *heldStore {
	s := &heldStore{Store: NewMemory(), entered: make(chan struct{}), release: make(chan struct{})}
	t.Cleanup(s.free)
	return s
}

func (s *heldStore) arm(op string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hold = op
}

func (s *heldStore) free() {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.release:
	default:
		close(s.release)
	}
}

func (s *heldStore) wait(op string) {
	s.mu.Lock()
	first := op == s.hold && s.calls == 0
	if op == s.hold {
		s.calls++
	}
	s.mu.Unlock()
	if first {
		close(s.entered)
		<-s.release
	}
}

func (s *heldStore) Get(id, binding string) ([]byte, error) {
	value, err := s.Store.Get(id, binding)
	s.wait("get")
	return value, err
}

func (s *heldStore) Put(id string, value []byte, binding string) error {
	s.wait("put")
	return s.Store.Put(id, value, binding)
}

func (s *heldStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

// coldVault stores weather and maps through warm, then reopens the index, so neither value is cached.
func coldVault(t *testing.T, store Store) *Vault {
	t.Helper()
	warm, path := openTemp(t, store)
	for _, id := range []string{"weather", "maps"} {
		if err := warm.Put(httpRecord(id), fakeValue); err != nil {
			t.Fatal(err)
		}
	}
	cold, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	return cold
}

func within(t *testing.T, what string, f func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		f()
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatalf("%s waited for a store call it does not need", what)
	}
}

// A Keychain read can run to the helper's deadline. Every request looks up records, so a read
// must hold up only the callers that need its value.
func TestAStalledStoreCallHoldsUpOnlyItsOwnSecret(t *testing.T) {
	for _, op := range []string{"get", "put"} {
		t.Run(op, func(t *testing.T) {
			store := newHeldStore(t)
			v := coldVault(t, store)
			store.arm(op)
			stalled := make(chan error, 1)
			go func() {
				if op == "get" {
					_, err := v.Value("weather")
					stalled <- err
				} else {
					stalled <- v.Put(httpRecord("weather"), []byte("rotated-fake-value-for-test"))
				}
			}()
			<-store.entered
			within(t, "Records", func() { v.Records() })
			within(t, "Record", func() { v.Record("maps") })
			within(t, "Value", func() {
				if got, err := v.Value("maps"); err != nil || !bytes.Equal(got, fakeValue) {
					t.Errorf("Value(maps) = %q, %v", got, err)
				}
			})
			store.free()
			if err := <-stalled; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConcurrentReadsOfASecretShareOneStoreRead(t *testing.T) {
	store := newHeldStore(t)
	v := coldVault(t, store)
	store.arm("get")
	values := make(chan []byte, 6)
	for range 6 {
		go func() {
			got, _ := v.Value("weather")
			values <- got
		}()
	}
	<-store.entered
	time.Sleep(50 * time.Millisecond)
	store.free()
	for range 6 {
		if got := <-values; !bytes.Equal(got, fakeValue) {
			t.Fatalf("a reader got %q", got)
		}
	}
	if n := store.count(); n != 1 {
		t.Fatalf("%d store reads for one secret, want 1", n)
	}
}

// A read that fails, as one of a locked Keychain does, is not repeated at once: requests that need
// the secret fail fast instead of each waiting out another read. A Put serves at once.
func TestAFailedReadIsHeldBriefly(t *testing.T) {
	flaky := &flakyStore{Memory: NewMemory()}
	store := &countingStore{Store: flaky}
	v := coldVault(t, store)
	now := time.Now()
	v.now = func() time.Time { return now }
	flaky.getFails = true
	for range 3 {
		if _, err := v.Value("weather"); err == nil {
			t.Fatal("a refused read succeeded")
		}
	}
	if store.gets != 1 {
		t.Fatalf("%d store reads while the first failure is held, want 1", store.gets)
	}
	flaky.getFails = false
	now = now.Add(time.Minute)
	if got, err := v.Value("weather"); err != nil || !bytes.Equal(got, fakeValue) || store.gets != 2 {
		t.Fatalf("after the hold Value = %q, %v with %d reads", got, err, store.gets)
	}
	flaky.getFails = true
	if _, err := v.Value("maps"); err == nil {
		t.Fatal("a refused read succeeded")
	}
	rotated := []byte("rotated-fake-value-for-test")
	if err := v.Put(httpRecord("maps"), rotated); err != nil {
		t.Fatal(err)
	}
	if got, err := v.Value("maps"); err != nil || !bytes.Equal(got, rotated) {
		t.Fatalf("after a Put Value = %q, %v", got, err)
	}
}

// A read that began before a Put returns what it read, but must not leave it in the cache.
func TestAReadThatOverlapsAPutLeavesTheNewValue(t *testing.T) {
	store := newHeldStore(t)
	v := coldVault(t, store)
	store.arm("get")
	read := make(chan []byte, 1)
	go func() {
		got, _ := v.Value("weather")
		read <- got
	}()
	<-store.entered
	rotated := []byte("rotated-fake-value-for-test")
	within(t, "Put", func() {
		if err := v.Put(httpRecord("weather"), rotated); err != nil {
			t.Error(err)
		}
	})
	store.free()
	if got := <-read; !bytes.Equal(got, fakeValue) {
		t.Fatalf("the overlapping read returned %q", got)
	}
	if got, err := v.Value("weather"); err != nil || !bytes.Equal(got, rotated) {
		t.Fatalf("after the overlapping read Value = %q, %v", got, err)
	}
	if err := v.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Value("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after Delete: %v", err)
	}
}
