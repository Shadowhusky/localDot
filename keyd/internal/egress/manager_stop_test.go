package egress

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Stall the storage backend after old requests have been canceled. The kill
// switch must work without releasing this stall, even for an unrelated cell.
func stalledReplacement(t *testing.T) (*Manager, Opened, <-chan error, func()) {
	t.Helper()
	m, _ := newManager(t)
	store := &blockedStore{Memory: vault.NewMemory()}
	m.d.Vault, _ = vault.Open(store, "")
	rec := vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}
	if _, err := m.PutSecret(rec, []byte(realValue)); err != nil {
		t.Fatal(err)
	}
	o, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.BeginTask("c1", "task-before-stop", 0); err != nil {
		t.Fatal(err)
	}
	store.entered, store.release = make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(store.release) }) }
	t.Cleanup(unblock)
	changed := make(chan error, 1)
	go func() { _, err := m.PutSecret(rec, []byte("replacement-secret-value")); changed <- err }()
	select {
	case <-store.entered:
	case <-time.After(time.Second):
		t.Fatal("replacement did not reach storage")
	}
	return m, o, changed, unblock
}

func TestStopDoesNotWaitForSecretStorage(t *testing.T) {
	for _, operation := range []string{"revoke", "close", "close-all"} {
		t.Run(operation, func(t *testing.T) {
			m, opened, changed, unblock := stalledReplacement(t)
			cell := m.cells["c1"].cell
			done := make(chan error, 1)
			go func() {
				switch operation {
				case "revoke":
					_, err := m.Revoke("c1")
					done <- err
				case "close":
					done <- m.Close("c1")
				case "close-all":
					m.CloseAll()
					done <- nil
				}
			}()
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(500 * time.Millisecond):
				t.Fatal("Stop waited for the stalled secret store")
			}
			// Revoke must not reopen admission midway through a policy write.
			if cell.current().ctx.Err() == nil {
				t.Fatal("a fresh request was admitted before storage completed")
			}
			if _, ok := m.d.Budget.Task("c1"); ok {
				t.Fatal("Stop left the task budget active")
			}
			unblock()
			if err := <-changed; err != nil {
				t.Fatal(err)
			}
			if _, ok := m.d.Registry.Lookup(opened.Surrogates["weather"]); ok {
				t.Fatal("publication restored a revoked credential")
			}
			if operation != "revoke" {
				if _, ok := m.Cell("c1"); ok || cell.current().ctx.Err() == nil {
					t.Fatal("publication reopened the closed cell")
				}
				if _, err := os.Stat(filepath.Dir(opened.CAPath)); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("closed cell left its CA behind")
				}
			}
			if operation == "close-all" {
				if _, err := m.Open(OpenRequest{CellID: "c2", Role: "desktop"}); !errors.Is(err, ErrManagerClosed) {
					t.Fatal("shutdown allowed a later cell to open")
				}
			}
		})
	}
}

func TestStopCancelsCredentialAndTaskRequestsWaitingForPublication(t *testing.T) {
	for _, action := range []string{"revoke", "close"} {
		for _, operation := range []string{"mint", "begin-task"} {
			t.Run(action+"/"+operation, func(t *testing.T) {
				m, _, changed, unblock := stalledReplacement(t)
				pending := make(chan error, 1)
				go func() {
					if operation == "mint" {
						_, err := m.Mint("c1", []string{"weather"})
						pending <- err
					} else {
						pending <- m.BeginTask("c1", "queued-before-stop", 0)
					}
				}()
				select {
				case err := <-pending:
					t.Fatalf("request escaped the pending publication: %v", err)
				case <-time.After(100 * time.Millisecond):
				}
				stopped := make(chan error, 1)
				go func() {
					if action == "close" {
						stopped <- m.Close("c1")
					} else {
						_, err := m.Revoke("c1")
						stopped <- err
					}
				}()
				select {
				case err := <-stopped:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(500 * time.Millisecond):
					t.Fatal("Stop waited for publication")
				}
				unblock()
				if err := <-changed; err != nil {
					t.Fatal(err)
				}
				if err := <-pending; err == nil {
					t.Fatal("a request queued before Stop reinstated access afterward")
				}
				if len(m.d.Registry.ForCell("c1")) != 0 {
					t.Fatal("a credential outlived Stop")
				}
				if _, ok := m.d.Budget.Task("c1"); ok {
					t.Fatal("a task outlived Stop")
				}
				// A deliberate request after Stop can resume normal operation.
				if action == "close" {
					if _, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}}); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := m.Mint("c1", []string{"weather"}); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

type stalledReadStore struct {
	*vault.Memory
	entered, release chan struct{}
}

func (s *stalledReadStore) Get(id, binding string) ([]byte, error) {
	close(s.entered)
	<-s.release
	return s.Memory.Get(id, binding)
}

func TestCredentialLookupDoesNotHoldTheStopLock(t *testing.T) {
	for _, operation := range []string{"open", "mint"} {
		t.Run(operation, func(t *testing.T) {
			m, _ := newManager(t)
			store := &stalledReadStore{Memory: vault.NewMemory(), entered: make(chan struct{}), release: make(chan struct{})}
			path := filepath.Join(t.TempDir(), "index.json")
			v, _ := vault.Open(store, path)
			rec := vault.Record{ID: "weather", Kind: vault.KindHTTP, Hosts: []string{"api.example.test"}, Header: "Authorization", Format: "bearer"}
			if err := v.Put(rec, []byte(realValue)); err != nil {
				t.Fatal(err)
			}
			// Reopen without the value cache: the first live request will need
			// the backend while credential issuance reads the metadata.
			m.d.Vault, _ = vault.Open(store, path)
			if _, err := m.Open(OpenRequest{CellID: "c1", Role: "desktop", Secrets: []string{"weather"}}); err != nil {
				t.Fatal(err)
			}
			var once sync.Once
			unblock := func() { once.Do(func() { close(store.release) }) }
			t.Cleanup(unblock)
			read := make(chan error, 1)
			go func() { _, err := m.d.Vault.Value("weather"); read <- err }()
			<-store.entered
			issued := make(chan error, 1)
			go func() {
				if operation == "open" {
					_, err := m.Open(OpenRequest{CellID: "c2", Role: "desktop", Secrets: []string{"weather"}})
					issued <- err
				} else {
					_, err := m.Mint("c1", []string{"weather"})
					issued <- err
				}
			}()
			select {
			case err := <-issued:
				t.Fatalf("issuance did not wait for the vault read: %v", err)
			case <-time.After(100 * time.Millisecond):
			}
			stopped := make(chan error, 1)
			go func() { _, err := m.Revoke("c1"); stopped <- err }()
			select {
			case err := <-stopped:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(500 * time.Millisecond):
				t.Fatal("credential lookup held Stop behind the vault")
			}
			unblock()
			if err := <-read; err != nil {
				t.Fatal(err)
			}
			err := <-issued
			if operation == "mint" && !errors.Is(err, ErrCellChanged) {
				t.Fatalf("the earlier mint request outlived Stop: %v", err)
			}
			if operation == "open" && err != nil {
				t.Fatal(err)
			}
		})
	}
}
