package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"regexp"
	"slices"
	"time"
)

// OAuthStatus says how a signed-in app's access token stands. It lives in the index and is listed
// to the daemon, so it holds no token: the refresh token and where it may go stay in a store item
// of their own (OAuthItem). Rewriting it outside keyd can only change when a refresh is tried.
type OAuthStatus struct {
	// Refreshes: keyd holds a refresh token for this secret.
	Refreshes bool `json:"refreshes,omitempty"`
	// ExpiresAt and RefreshAt are zero when the app did not say how long its token lasts.
	ExpiresAt time.Time `json:"expiresAt,omitzero"`
	RefreshAt time.Time `json:"refreshAt,omitzero"`
	// Account is who the app says signed in, if it says: for showing, never for deciding anything.
	Account string `json:"account,omitempty"`
	// Reconnect: the app ended this sign-in, so the user signs in again.
	Reconnect bool `json:"reconnect,omitempty"`
}

var oauthItem = regexp.MustCompile(`^oauth-[0-9a-f]{56}$`)

// OAuthItem names the store item that holds a signed-in secret's refresh state, and the binding it
// is stored under. The name is outside what Writable lets a user secret take.
func OAuthItem(id string) (item, binding string) {
	sum := sha256.Sum256([]byte("localdot-oauth-v1\x00" + id))
	digest := hex.EncodeToString(sum[:])
	return "oauth-" + digest[:56], digest
}

// Rotate replaces a secret's value behind its surrogates: its binding stays, so they stay valid and
// nothing in flight is cut. The value it replaces is kept in memory for Former.
func (v *Vault) Rotate(id string, value []byte, status *OAuthStatus) error {
	rec, ok := v.Record(id)
	if !ok {
		return ErrNotFound
	}
	former, _ := v.Value(id)
	rec.OAuth = status
	if err := v.Put(rec, value); err != nil {
		return err
	}
	if former != nil {
		v.mu.Lock()
		v.former[id] = former
		v.mu.Unlock()
	}
	return nil
}

// Former is the value Rotate last replaced, still good at its app until it expires: a response may
// echo it, so it is scrubbed like the current one.
func (v *Vault) Former(id string) []byte {
	v.mu.Lock()
	defer v.mu.Unlock()
	return slices.Clone(v.former[id])
}

// SetOAuth changes no routing field and never opens the secret's value.
func (v *Vault) SetOAuth(id string, status *OAuthStatus) error {
	v.change.Lock()
	defer v.change.Unlock()
	v.mu.Lock()
	defer v.mu.Unlock()
	old, ok := v.records[id]
	if !ok {
		return ErrNotFound
	}
	next := old.clone()
	next.OAuth = status
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

// Clone gives the caller a record of its own to change.
func (r Record) Clone() Record { return r.clone() }
