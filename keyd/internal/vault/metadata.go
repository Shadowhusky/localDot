package vault

import (
	"errors"
	"unicode"
	"unicode/utf8"
)

// Metadata is user-authored discovery data, never authority or part of a credential's destination.
// Keeping it outside bindingFields preserves existing encrypted values and sealed submissions.
type Metadata struct {
	Label       string `json:"label,omitempty"`
	Service     string `json:"service,omitempty"`
	Description string `json:"description,omitempty"`
}

func (m *Metadata) Validate() error {
	if m == nil {
		return nil
	}
	for _, f := range []struct {
		s   string
		max int
	}{{m.Label, 80}, {m.Service, 80}, {m.Description, 600}} {
		if !utf8.ValidString(f.s) || utf8.RuneCountInString(f.s) > f.max {
			return errors.New("invalid key description")
		}
		for _, c := range f.s {
			if unicode.IsControl(c) || unicode.Is(unicode.Cf, c) {
				return errors.New("invalid key description")
			}
		}
	}
	return nil
}

// SetMetadata changes no routing field and never opens or returns the secret value.
func (v *Vault) SetMetadata(id string, metadata Metadata) error {
	if err := metadata.Validate(); err != nil {
		return err
	}
	v.change.Lock()
	defer v.change.Unlock()
	v.mu.Lock()
	defer v.mu.Unlock()
	old, ok := v.records[id]
	if !ok {
		return ErrNotFound
	}
	next := old.clone()
	next.Metadata = &metadata
	next.UpdatedAt = v.now().UTC()
	v.records[id] = next
	if err := v.saveLocked(); err != nil {
		v.records[id] = old
		if errors.Is(err, errNotSynced) {
			_ = v.saveLocked()
		}
		return err
	}
	return nil
}
