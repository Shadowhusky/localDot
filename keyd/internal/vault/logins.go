package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
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
	return l.store.Put(id, raw, binding)
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
	return l.store.Delete(id)
}
