package vault

import (
	"errors"
	"fmt"
	"slices"
	"sync"
)

// ErrNotFound means the store has no value for the id.
var ErrNotFound = errors.New("vault: secret not found")

// errUnchanged, wrapped in a Put's error, means the Put wrote nothing: the old value is still whole.
var errUnchanged = errors.New("nothing was written")

// ErrReenter, wrapped in a Get's error, means the stored value can never be read as it is stored:
// only storing it again makes it usable.
var ErrReenter = errors.New("store it again")

// errRebound means the value was stored for another binding than the one asked for: the index
// that names the binding was rewritten after keyd stored the value.
var errRebound = fmt.Errorf("the value was stored for another destination; %w", ErrReenter)

// ReentryError is Value's error for a secret whose record stands but whose stored value is gone or
// can never be read as it is stored: the user enters the value again.
type ReentryError struct {
	ID  string
	err error
}

func (e *ReentryError) Error() string {
	return "vault: secret " + e.ID + " needs re-entering: " + e.err.Error()
}

func (e *ReentryError) Unwrap() error { return e.err }

// needsReentry reports whether a store's Get error means only storing the value again helps.
func needsReentry(err error) bool {
	return errors.Is(err, ErrNotFound) || errors.Is(err, ErrReenter)
}

// Store keeps secret values by id, each with the binding it was stored for; the Keychain in
// production, Memory in tests. Get returns a value only for the binding it was stored with.
type Store interface {
	Put(id string, value []byte, binding string) error
	Get(id string, binding string) ([]byte, error)
	Delete(id string) error
}

// Memory is a Store that lives only as long as the process.
type Memory struct {
	mu     sync.Mutex
	values map[string]memoryItem
}

type memoryItem struct {
	value   []byte
	binding string
}

func NewMemory() *Memory {
	return &Memory{values: map[string]memoryItem{}}
}

func (m *Memory) Put(id string, value []byte, binding string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[id] = memoryItem{value: slices.Clone(value), binding: binding}
	return nil
}

func (m *Memory) Get(id string, binding string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	item, ok := m.values[id]
	if !ok {
		return nil, ErrNotFound
	}
	if item.binding != binding {
		return nil, fmt.Errorf("vault: %s: %w", id, errRebound)
	}
	return slices.Clone(item.value), nil
}

func (m *Memory) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.values[id]; !ok {
		return ErrNotFound
	}
	delete(m.values, id)
	return nil
}
