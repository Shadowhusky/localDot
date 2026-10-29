package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"slices"
	"strings"
	"sync"
	"unicode/utf8"
)

// Logins keeps site credentials in the same protected system store as API keys, under
// a separate namespace. Neither account names nor passwords are written to the index.
// The exact HTTPS origin is part of the store's authenticated binding.
type Logins struct {
	store Store
	mu    sync.Mutex
}
type Login struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func NewLogins(store Store) *Logins { return &Logins{store: store} }

// An item id is a one-way digest of its origin, so the origins Put saved are kept in an item of
// their own, protected like the logins, for List. Logins saved before it existed are not listed.
const loginOriginsID = "login-origins"

var loginOriginsBinding = func() string {
	sum := sha256.Sum256([]byte("localdot-login-origins-v1"))
	return hex.EncodeToString(sum[:])
}()

// List names the origins of the saved logins this keyd knows of.
func (l *Logins) List() ([]string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.originsLocked()
}

func (l *Logins) originsLocked() ([]string, error) {
	raw, err := l.store.Get(loginOriginsID, loginOriginsBinding)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var origins []string
	if json.Unmarshal(raw, &origins) != nil {
		return nil, errors.New("invalid saved login list")
	}
	return origins, nil
}

// noteLocked adds or removes origin in the list. A list that would outgrow one item keeps the
// origins it has: the login is saved all the same, only not listed.
func (l *Logins) noteLocked(origin string, saved bool) error {
	origins, err := l.originsLocked()
	if err != nil {
		return err
	}
	at := slices.Index(origins, origin)
	switch {
	case saved && at >= 0, !saved && at < 0:
		return nil
	case saved:
		origins = append(origins, origin)
	default:
		origins = slices.Delete(origins, at, at+1)
	}
	if len(origins) == 0 {
		if err := l.store.Delete(loginOriginsID); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		return nil
	}
	raw, err := json.Marshal(origins)
	if err != nil || len(raw) > maxValueLen {
		return nil
	}
	return l.store.Put(loginOriginsID, raw, loginOriginsBinding)
}
func loginIdentity(origin string) (string, string, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" || strings.ToLower(u.Host) != u.Host || len(origin) > 2048 {
		return "", "", errors.New("invalid login origin")
	}
	sum := sha256.Sum256([]byte("localdot-login-v1\x00" + origin))
	digest := hex.EncodeToString(sum[:])
	return "login-" + digest[:56], digest, nil
}
func (l *Logins) Put(origin string, login Login) error {
	id, binding, err := loginIdentity(origin)
	if err != nil {
		return err
	}
	if len(login.Username) > 2000 || len(login.Password) == 0 || len(login.Password) > 4000 || !utf8.ValidString(login.Username) || !utf8.ValidString(login.Password) {
		return errors.New("invalid login")
	}
	raw, err := json.Marshal(login)
	if err != nil || len(raw) > 8192 {
		return errors.New("invalid login")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.store.Put(id, raw, binding); err != nil {
		return err
	}
	return l.noteLocked(origin, true)
}
func (l *Logins) Get(origin string) (Login, error) {
	id, binding, err := loginIdentity(origin)
	if err != nil {
		return Login{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	raw, err := l.store.Get(id, binding)
	if err != nil {
		return Login{}, err
	}
	var login Login
	if len(raw) > 8192 || json.Unmarshal(raw, &login) != nil || login.Password == "" {
		return Login{}, errors.New("invalid saved login")
	}
	return login, nil
}
func (l *Logins) Delete(origin string) error {
	id, _, err := loginIdentity(origin)
	if err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	err = l.store.Delete(id)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	if noted := l.noteLocked(origin, false); noted != nil {
		return noted
	}
	return err
}
