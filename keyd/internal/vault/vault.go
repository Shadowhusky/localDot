// Package vault keeps keyd's secrets: values in a Store, metadata in an index file that never
// holds a value.
package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"
)

type Kind string

const (
	KindLLM  Kind = "llm"
	KindHTTP Kind = "http"
)

// Record describes a secret and where it may be used. keys.FromRecord validates the binding
// fields; the vault checks only the id, the kind and the value.
type Record struct {
	ID        string    `json:"id"`
	Kind      Kind      `json:"kind"`
	Provider  string    `json:"provider,omitempty"`
	BaseURL   string    `json:"baseURL,omitempty"`
	Hosts     []string  `json:"hosts,omitempty"`
	Header    string    `json:"header,omitempty"`
	Format    string    `json:"format,omitempty"`
	Methods   []string  `json:"methods,omitempty"`
	Paths     []string  `json:"paths,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

const (
	minValueLen = 8
	maxValueLen = 8192
)

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	// The LLM gateway's local routes share the gateway's namespace with secret ids.
	reservedIDs = []string{"lmstudio", "ollama"}
)

// ValidID reports whether id can name a secret.
func ValidID(id string) bool {
	return idPattern.MatchString(id) && !slices.Contains(reservedIDs, id)
}

// ValidValue rejects values that could break a header or match too much when scrubbed.
func ValidValue(value []byte) error {
	if len(value) < minValueLen || len(value) > maxValueLen {
		return fmt.Errorf("secret value must be %d-%d bytes", minValueLen, maxValueLen)
	}
	for _, b := range value {
		if b < 0x20 || b > 0x7e {
			return errors.New("secret value must be printable ASCII")
		}
	}
	if value[0] == ' ' || value[len(value)-1] == ' ' {
		return errors.New("secret value must not start or end with a space")
	}
	return nil
}

type indexFile struct {
	V       int      `json:"v"`
	Secrets []Record `json:"secrets"`
}

// Vault is safe for concurrent use.
type Vault struct {
	store   Store
	path    string
	now     func() time.Time
	mu      sync.Mutex
	records map[string]Record
	cache   map[string][]byte
}

// Open loads the index at path; a missing file is an empty vault. An empty path keeps the index
// in memory only, for a vault whose values are in memory too.
func Open(store Store, path string) (*Vault, error) {
	v := &Vault{store: store, path: path, now: time.Now, records: map[string]Record{}, cache: map[string][]byte{}}
	if path == "" {
		return v, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return nil, err
	}
	var idx indexFile
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("vault index %s: %w", path, err)
	}
	for _, r := range idx.Secrets {
		v.records[r.ID] = r
	}
	return v, nil
}

func (v *Vault) Put(rec Record, value []byte) error {
	if !ValidID(rec.ID) {
		return fmt.Errorf("secret id %q: want 1-64 of a-z 0-9 _ - starting with a letter or digit, not a reserved name", rec.ID)
	}
	if rec.Kind != KindLLM && rec.Kind != KindHTTP {
		return fmt.Errorf("secret kind %q: want llm or http", rec.Kind)
	}
	if err := ValidValue(value); err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now().UTC()
	rec.CreatedAt, rec.UpdatedAt = now, now
	if old, ok := v.records[rec.ID]; ok {
		rec.CreatedAt = old.CreatedAt
	}
	if err := v.store.Put(rec.ID, value); err != nil {
		return err
	}
	v.records[rec.ID] = rec
	v.cache[rec.ID] = slices.Clone(value)
	return v.saveLocked()
}

func (v *Vault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id]; !ok {
		return ErrNotFound
	}
	if err := v.store.Delete(id); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	delete(v.records, id)
	delete(v.cache, id)
	return v.saveLocked()
}

func (v *Vault) Record(id string) (Record, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	r, ok := v.records[id]
	return r, ok
}

func (v *Vault) Records() []Record {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]Record, 0, len(v.records))
	for _, r := range v.records {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Value returns the secret, reading the store only on the first use.
func (v *Vault) Value(id string) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id]; !ok {
		return nil, ErrNotFound
	}
	if cached, ok := v.cache[id]; ok {
		return slices.Clone(cached), nil
	}
	value, err := v.store.Get(id)
	if err != nil {
		return nil, err
	}
	v.cache[id] = slices.Clone(value)
	return value, nil
}

func (v *Vault) saveLocked() error {
	if v.path == "" {
		return nil
	}
	idx := indexFile{V: 1, Secrets: make([]Record, 0, len(v.records))}
	for _, r := range v.records {
		idx.Secrets = append(idx.Secrets, r)
	}
	sort.Slice(idx.Secrets, func(i, j int) bool { return idx.Secrets[i].ID < idx.Secrets[j].ID })
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(v.path, data)
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".secrets-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
