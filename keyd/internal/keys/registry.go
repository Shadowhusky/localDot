package keys

import (
	"sync"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

// Entry is one minted surrogate. Token is the surrogate itself and never leaves keyd except in
// the admin reply that hands it to the cell; ID names it everywhere else.
type Entry struct {
	Token   string
	ID      string
	Cell    string
	Binding Binding
}

type Registry struct {
	mu      sync.RWMutex
	byToken map[string]Entry
}

func NewRegistry() *Registry {
	return &Registry{byToken: map[string]Entry{}}
}

func (r *Registry) Mint(cell string, b Binding) (Entry, error) {
	token, err := surrogate.Mint(b.Tag)
	if err != nil {
		return Entry{}, err
	}
	e := Entry{Token: token, ID: surrogate.ID(token), Cell: cell, Binding: b}
	r.mu.Lock()
	r.byToken[token] = e
	r.mu.Unlock()
	return e, nil
}

func (r *Registry) Lookup(token string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.byToken[token]
	return e, ok
}

func (r *Registry) ForCell(cell string) []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []Entry
	for _, e := range r.byToken {
		if e.Cell == cell {
			out = append(out, e)
		}
	}
	return out
}

// RevokeSecret drops every surrogate of the secret, in every cell: a replaced or deleted secret
// must not keep surrogates minted under its old binding.
func (r *Registry) RevokeSecret(secretID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for token, e := range r.byToken {
		if e.Binding.SecretID == secretID {
			delete(r.byToken, token)
			n++
		}
	}
	return n
}

// RevokeCell drops every surrogate of the cell and returns how many there were.
func (r *Registry) RevokeCell(cell string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for token, e := range r.byToken {
		if e.Cell == cell {
			delete(r.byToken, token)
			n++
		}
	}
	return n
}
