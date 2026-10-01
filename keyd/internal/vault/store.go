package vault

import (
	"errors"
	"slices"
	"sync"
)

// ErrNotFound means the store has no value for the id.
var ErrNotFound = errors.New("vault: secret not found")

// Store keeps secret values by id; the Keychain in production, Memory in tests.
type Store interface {
	Put(id string, value []byte) error
	Get(id string) ([]byte, error)
	Delete(id string) error
}

// Memory is a Store that lives only as long as the process.
type Memory struct {
	mu     sync.Mutex
	values map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{values: map[string][]byte{}}
}

func (m *Memory) Put(id string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[id] = slices.Clone(value)
	return nil
}

func (m *Memory) Get(id string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[id]
	if !ok {
		return nil, ErrNotFound
	}
	return slices.Clone(v), nil
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
