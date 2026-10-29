// Package vault keeps keyd's secrets: values in a Store, metadata in an index file that never
// holds a value. The Store keeps each value with a digest of its binding, so an index rewritten
// outside keyd cannot send a stored value anywhere else.
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
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Kind string

const (
	KindLLM    Kind = "llm"
	KindHTTP   Kind = "http"
	KindSecret Kind = "secret"
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
	Metadata  *Metadata `json:"metadata,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

func (r Record) clone() Record {
	if r.Metadata != nil {
		m := *r.Metadata
		r.Metadata = &m
	}
	r.Hosts = slices.Clone(r.Hosts)
	r.Methods = slices.Clone(r.Methods)
	r.Paths = slices.Clone(r.Paths)
	return r
}

func validKind(k Kind) bool {
	return k == KindLLM || k == KindHTTP || k == KindSecret
}

const (
	minValueLen  = 8
	maxValueLen  = 8192
	indexVersion = 1
)

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	// The LLM gateway's local routes share the gateway's namespace with secret ids.
	reservedIDs = []string{"lmstudio", "ollama"}
)

// PushKeyID names the Keychain item that holds keyd's own Web Push (VAPID) key. No user secret may
// take it; an index that already names it still opens, and the push signer refuses to use the item.
const PushKeyID = "webpush-vapid"

// Writable reports whether a user secret may be stored under id.
func Writable(id string) bool {
	return ValidID(id) && id != PushKeyID && !strings.HasPrefix(id, "login-")
}

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

// ValidGeneralValue preserves UTF-8, whitespace and line breaks for application secrets.
func ValidGeneralValue(value []byte) error {
	if len(value) == 0 || len(value) > maxValueLen || !utf8.Valid(value) || strings.ContainsRune(string(value), 0) {
		return errors.New("secret value must be 1-8192 UTF-8 bytes without NUL")
	}
	return nil
}

type indexFile struct {
	V       int      `json:"v"`
	Secrets []Record `json:"secrets"`
}

// Vault is safe for concurrent use. Every request looks records up, and a Keychain call can run
// to its deadline, so mu guards only the maps and is never held across a store call; change orders
// Put and Delete.
type Vault struct {
	store   Store
	path    string
	now     func() time.Time
	write   func(path string, data []byte) error
	change  sync.Mutex
	mu      sync.Mutex
	records map[string]Record
	cache   map[string][]byte
	reads   map[string]*read
	failed  map[string]failure
	// attention holds the records whose stored values cannot be used as they are stored, and why.
	attention map[string]Attention
}

// Attention says why a record's stored value cannot be used until the user acts.
type Attention string

const (
	// Reenter: the stored value is gone or can never be read as stored; the user enters it again.
	Reenter Attention = "reenter"
	// Rebound: the value was stored for another destination than the record names, so the record
	// was changed outside keyd; the user removes the key and adds it again.
	Rebound Attention = "rebound"
)

// attentionOf is the attention a store's Get error calls for, if any.
func attentionOf(err error) Attention {
	switch {
	case errors.Is(err, ErrRebound):
		return Rebound
	case needsReentry(err):
		return Reenter
	}
	return ""
}

// read is a store read that every caller of Value for the secret waits on.
type read struct {
	done  chan struct{}
	value []byte
	err   error
}

// A failed read is held this long, so the requests behind it fail fast instead of each waiting out
// another read of a locked or stalled Keychain.
const failureHold = 5 * time.Second

type failure struct {
	err   error
	until time.Time
}

// Open loads the index at path; a missing file is an empty vault. An empty path keeps the index
// in memory only, for a vault whose values are in memory too. An index keyd could not have written
// is refused whole.
func Open(store Store, path string) (*Vault, error) {
	v := &Vault{
		store: store, path: path, now: time.Now, write: writeFileAtomic,
		records: map[string]Record{}, cache: map[string][]byte{}, reads: map[string]*read{}, failed: map[string]failure{},
		attention: map[string]Attention{},
	}
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
	if idx.V != indexVersion {
		return nil, fmt.Errorf("vault index %s: version %d, want %d", path, idx.V, indexVersion)
	}
	for _, r := range idx.Secrets {
		_, repeated := v.records[r.ID]
		switch {
		case !ValidID(r.ID):
			return nil, fmt.Errorf("vault index %s: secret id %q is invalid or reserved", path, r.ID)
		case !validKind(r.Kind):
			return nil, fmt.Errorf("vault index %s: secret %s has unknown kind %q", path, r.ID, r.Kind)
		case repeated:
			return nil, fmt.Errorf("vault index %s: secret %s appears twice", path, r.ID)
		}
		v.records[r.ID] = r
	}
	return v, nil
}

// Put stores the value, then the record. An error means nothing changed, as far as the store and the
// disk allow: the old record and value stay in force, or a new secret leaves nothing behind. Where
// that cannot be ensured, the secret fails closed instead: its value is deleted when the index on
// disk may name either binding, and its record leaves memory when a value that must go cannot.
func (v *Vault) Put(rec Record, value []byte) error {
	if !Writable(rec.ID) {
		return fmt.Errorf("secret id %q: want 1-64 of a-z 0-9 _ - starting with a letter or digit, not a reserved name", rec.ID)
	}
	if !validKind(rec.Kind) {
		return fmt.Errorf("secret kind %q: want llm, http or secret", rec.Kind)
	}
	if err := rec.Metadata.Validate(); err != nil {
		return err
	}
	validate := ValidValue
	if rec.Kind == KindSecret {
		validate = ValidGeneralValue
	}
	if err := validate(value); err != nil {
		return err
	}
	rec = rec.clone()
	v.change.Lock()
	defer v.change.Unlock()
	v.mu.Lock()
	now := v.now().UTC()
	rec.CreatedAt, rec.UpdatedAt = now, now
	old, had := v.records[rec.ID]
	var prev []byte
	if had {
		rec.CreatedAt = old.CreatedAt
		// Re-entering the same key preserves its public description.
		if rec.Metadata == nil && bindingOf(rec) == bindingOf(old) {
			rec.Metadata = old.clone().Metadata
		}
		prev = v.cache[rec.ID]
	}
	v.mu.Unlock()
	if had && prev == nil {
		prev, _ = v.store.Get(rec.ID, bindingOf(old))
	}
	if err := v.store.Put(rec.ID, value, bindingOf(rec)); err != nil {
		if !errors.Is(err, errUnchanged) {
			v.restore(rec.ID, old, prev)
		}
		return err
	}
	v.mu.Lock()
	v.records[rec.ID] = rec
	err := v.saveLocked()
	if err == nil {
		v.settleLocked(rec.ID, slices.Clone(value))
		v.mu.Unlock()
		return nil
	}
	if had {
		v.records[rec.ID] = old
	} else {
		delete(v.records, rec.ID)
	}
	// A rename that landed before its directory sync failed left the new index on disk; if the
	// old one cannot be put back, the index may name either binding, so neither keeps a value.
	if errors.Is(err, errNotSynced) && v.saveLocked() != nil {
		prev = nil
	}
	v.mu.Unlock()
	v.restore(rec.ID, old, prev)
	return err
}

// restore undoes a store write that Put cannot keep. Without an old value to put back, it deletes
// the item, so a restored record never meets the new value; and if the item cannot be deleted, the
// record leaves memory, so this process fails closed.
func (v *Vault) restore(id string, old Record, prev []byte) {
	var deleted error
	if prev == nil || v.store.Put(id, prev, bindingOf(old)) != nil {
		deleted = v.store.Delete(id)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.settleLocked(id, prev)
	if prev == nil && deleted != nil && !errors.Is(deleted, ErrNotFound) {
		delete(v.records, id)
	}
	if _, kept := v.records[id]; kept && prev == nil {
		v.attention[id] = Reenter
	}
}

// settleLocked records what the store holds for id after a change: value, or nil for the next
// read to fetch. A read still in flight began before the change, so its result is not kept.
func (v *Vault) settleLocked(id string, value []byte) {
	delete(v.reads, id)
	delete(v.failed, id)
	delete(v.attention, id)
	if value == nil {
		delete(v.cache, id)
	} else {
		v.cache[id] = value
	}
}

func (v *Vault) Delete(id string) error {
	v.change.Lock()
	defer v.change.Unlock()
	v.mu.Lock()
	_, ok := v.records[id]
	v.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	if err := v.store.Delete(id); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	delete(v.records, id)
	v.settleLocked(id, nil)
	return v.saveLocked()
}

func (v *Vault) Record(id string) (Record, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	r, ok := v.records[id]
	return r.clone(), ok
}

func (v *Vault) Records() []Record {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]Record, 0, len(v.records))
	for _, r := range v.records {
		out = append(out, r.clone())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Value returns the secret, reading the store only on the first use. Callers that need the secret
// while it is being read share that read.
func (v *Vault) Value(id string) ([]byte, error) {
	v.mu.Lock()
	rec, ok := v.records[id]
	if !ok {
		v.mu.Unlock()
		return nil, ErrNotFound
	}
	if cached, ok := v.cache[id]; ok {
		v.mu.Unlock()
		return slices.Clone(cached), nil
	}
	if f, ok := v.failed[id]; ok && v.now().Before(f.until) {
		v.mu.Unlock()
		return nil, f.err
	}
	r, reading := v.reads[id]
	if !reading {
		r = &read{done: make(chan struct{})}
		v.reads[id] = r
	}
	v.mu.Unlock()
	if !reading {
		value, err := v.store.Get(id, bindingOf(rec))
		attention := attentionOf(err)
		v.mu.Lock()
		// A value the migration found stored for another destination stays that, though the store
		// reads its unbound item as one to enter again.
		if attention == Reenter && v.attention[id] == Rebound {
			attention = Rebound
		}
		r.value, r.err = value, err
		switch attention {
		case Rebound:
			r.err = &ReboundError{ID: id}
		case Reenter:
			r.err = &ReentryError{ID: id, err: err}
		}
		if v.reads[id] == r {
			delete(v.reads, id)
			if r.err == nil {
				v.cache[id] = r.value
			} else {
				v.failed[id] = failure{err: r.err, until: v.now().Add(failureHold)}
				if attention != "" {
					v.attention[id] = attention
				}
			}
		}
		v.mu.Unlock()
		close(r.done)
	}
	<-r.done
	if r.err != nil {
		return nil, r.err
	}
	return slices.Clone(r.value), nil
}

// Forget deletes every item the store keeps and every record, for a dot that is being removed: the
// store's own items go too, saved logins, the push key and, on the Keychain, the bindings marker and
// this keyd's claim, last. It reports how many records it removed.
func (v *Vault) Forget() (int, error) {
	store, ok := v.store.(interface{ forgetAll() error })
	if !ok {
		return 0, errors.New("vault: this store cannot be cleared")
	}
	v.change.Lock()
	defer v.change.Unlock()
	if err := store.forgetAll(); err != nil {
		return 0, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	n := len(v.records)
	v.records = map[string]Record{}
	v.cache, v.reads, v.failed, v.attention = map[string][]byte{}, map[string]*read{}, map[string]failure{}, map[string]Attention{}
	return n, v.saveLocked()
}

// MigrateBindings runs the store's binding migration, if it has one, over every record, and keeps
// which records need the user. keyd runs it once at start, before serving.
func (v *Vault) MigrateBindings() Migration {
	store, ok := v.store.(interface {
		MigrateBindings(records []Record) Migration
	})
	if !ok {
		return Migration{Done: true}
	}
	v.change.Lock()
	defer v.change.Unlock()
	m := store.MigrateBindings(v.Records())
	v.mu.Lock()
	defer v.mu.Unlock()
	for attention, ids := range map[Attention][]string{Reenter: m.Reenter, Rebound: m.Rebound} {
		for _, id := range ids {
			if _, ok := v.records[id]; ok {
				v.attention[id] = attention
			}
		}
	}
	return m
}

// Attention reports why id's stored value is known to be unusable as it is stored, until a Put
// stores it again or a Delete removes it; empty when nothing is known to be wrong.
func (v *Vault) Attention(id string) Attention {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.attention[id]
}

func (v *Vault) saveLocked() error {
	if v.path == "" {
		return nil
	}
	idx := indexFile{V: indexVersion, Secrets: make([]Record, 0, len(v.records))}
	for _, r := range v.records {
		idx.Secrets = append(idx.Secrets, r)
	}
	sort.Slice(idx.Secrets, func(i, j int) bool { return idx.Secrets[i].ID < idx.Secrets[j].ID })
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return v.write(v.path, data)
}

// errNotSynced, wrapped in a save's error, means its rename landed: the new index is in place, but
// its directory was not synced.
var errNotSynced = errors.New("the index's directory was not synced")

// writeFileAtomic syncs the new file before renaming it over path, and the directory after, so a
// crash leaves the old index or the new one, never an empty file or a lost rename.
func writeFileAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".secrets-*")
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
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return err
	}
	if err := syncDir(dir); err != nil {
		return fmt.Errorf("%w: %w", errNotSynced, err)
	}
	return nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
