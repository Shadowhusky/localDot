package keys

import (
	"fmt"
	"io"
	"strings"
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

// String names the entry as audit lines do, surrogate:<ID>, never by its token.
func (e Entry) String() string {
	id := e.ID
	if id == "" && e.Token != "" {
		id = surrogate.ID(e.Token)
	}
	return "surrogate:" + id
}

// Format prints String under every verb, so no verb, %+v and %#v included, prints the token.
func (e Entry) Format(f fmt.State, _ rune) {
	io.WriteString(f, e.String())
}

func (e Entry) clone() Entry {
	e.Binding = e.Binding.clone()
	return e
}

type Registry struct {
	mu      sync.RWMutex
	byToken map[string]Entry
	// byFolded maps each token, lower-cased, to the token, so a surrogate found in a header name
	// resolves without a scan. Mint keeps the lower-cased forms unique.
	byFolded map[string]string
}

func NewRegistry() *Registry {
	return &Registry{byToken: map[string]Entry{}, byFolded: map[string]string{}}
}

func (r *Registry) Mint(cell string, b Binding) (Entry, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		token, err := surrogate.Mint(b.Tag)
		if err != nil {
			return Entry{}, err
		}
		folded := strings.ToLower(token)
		if _, taken := r.byFolded[folded]; taken {
			continue
		}
		e := Entry{Token: token, ID: surrogate.ID(token), Cell: cell, Binding: b.clone()}
		r.byToken[token] = e
		r.byFolded[folded] = token
		return e.clone(), nil
	}
}

func (r *Registry) Lookup(token string) (Entry, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.byToken[token]
	return e.clone(), ok
}

// lookupFolded finds the entry whose token, lower-cased, is folded: a surrogate found in a header
// name, whose case net/http has changed.
func (r *Registry) lookupFolded(folded string) (Entry, bool) {
	countSteps(1)
	r.mu.RLock()
	defer r.mu.RUnlock()
	token, ok := r.byFolded[folded]
	if !ok {
		return Entry{}, false
	}
	return r.byToken[token].clone(), true
}

func (r *Registry) ForCell(cell string) []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var out []Entry
	for _, e := range r.byToken {
		if e.Cell == cell {
			out = append(out, e.clone())
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
			r.drop(token)
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
			r.drop(token)
			n++
		}
	}
	return n
}

// drop removes a token and its lower-cased form; the caller holds r.mu.
func (r *Registry) drop(token string) {
	delete(r.byToken, token)
	delete(r.byFolded, strings.ToLower(token))
}
