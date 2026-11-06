package vault

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
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
	// What the list items hold, as stored, once read. Only this keyd writes them.
	loaded  bool
	entries []LoginEntry
	pages   [][]byte
}
type Login struct {
	Username string `json:"username"`
	Password string `json:"password"`
	// Added in Settings or imported: a task fills it only after the user's tap. A later save of the
	// same site never clears it.
	Confirm bool `json:"confirm,omitempty"`
}

// LoginEntry is what the list shows of a saved login, never its password.
type LoginEntry struct {
	Origin   string `json:"origin"`
	Username string `json:"username"`
	Confirm  bool   `json:"confirm,omitempty"`
}

// MaxLogins bounds what a list reply and an import can reach.
const MaxLogins = 3000

func NewLogins(store Store) *Logins { return &Logins{store: store} }

// An item id is a one-way digest of its origin, so the entries Put saved are kept in items of
// their own, protected like the logins, for List. Logins saved before such a list existed are not
// listed; those on the origins-only list that came before this one move over when it is first read.
const loginOriginsID = "login-origins"

var loginOriginsBinding = fixedBinding("localdot-login-origins-v1")
var loginListBinding = fixedBinding("localdot-login-list-v1")

func fixedBinding(name string) string {
	sum := sha256.Sum256([]byte(name))
	return hex.EncodeToString(sum[:])
}

func loginListID(page int) string { return fmt.Sprintf("login-list-%d", page) }

// Entries names the saved logins this keyd knows of.
func (l *Logins) Entries() ([]LoginEntry, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.loadLocked(); err != nil {
		return nil, err
	}
	return slices.Clone(l.entries), nil
}

// List names the origins of the saved logins this keyd knows of.
func (l *Logins) List() ([]string, error) {
	entries, err := l.Entries()
	if err != nil {
		return nil, err
	}
	origins := make([]string, len(entries))
	for i, entry := range entries {
		origins[i] = entry.Origin
	}
	return origins, nil
}

// Find is the listed login of origin without reading its password.
func (l *Logins) Find(origin string) (LoginEntry, error) {
	if _, _, err := loginIdentity(origin); err != nil {
		return LoginEntry{}, err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.loadLocked(); err != nil {
		return LoginEntry{}, err
	}
	if at := l.findLocked(origin); at >= 0 {
		return l.entries[at], nil
	}
	return LoginEntry{}, ErrNotFound
}

// Reset forgets what was read of the list, for a store that was emptied behind it.
func (l *Logins) Reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.loaded, l.entries, l.pages = false, nil, nil
}

func (l *Logins) findLocked(origin string) int {
	return slices.IndexFunc(l.entries, func(entry LoginEntry) bool { return entry.Origin == origin })
}

func (l *Logins) loadLocked() error {
	if l.loaded {
		return nil
	}
	var entries []LoginEntry
	var pages [][]byte
	for page := 0; ; page++ {
		raw, err := l.store.Get(loginListID(page), loginListBinding)
		if errors.Is(err, ErrNotFound) {
			break
		}
		if err != nil {
			return err
		}
		var held []LoginEntry
		if json.Unmarshal(raw, &held) != nil {
			return errors.New("invalid saved login list")
		}
		entries, pages = append(entries, held...), append(pages, raw)
	}
	raw, err := l.store.Get(loginOriginsID, loginOriginsBinding)
	if errors.Is(err, ErrNotFound) {
		l.loaded, l.entries, l.pages = true, entries, pages
		return nil
	}
	if err != nil {
		return err
	}
	var origins []string
	if json.Unmarshal(raw, &origins) != nil {
		return errors.New("invalid saved login list")
	}
	for _, origin := range origins {
		if slices.ContainsFunc(entries, func(entry LoginEntry) bool { return entry.Origin == origin }) {
			continue
		}
		login, err := l.getLocked(origin)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if errors.Is(err, ErrLocked) {
			return err
		}
		// One that can't be read still shows, so it can be removed.
		entries = append(entries, LoginEntry{Origin: origin, Username: login.Username, Confirm: login.Confirm})
	}
	l.entries, l.pages = entries, pages
	if err := l.saveListLocked(); err != nil {
		return err
	}
	l.loaded = true
	if err := l.store.Delete(loginOriginsID); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

// saveListLocked writes the list in as many items as it takes, only those that changed.
func (l *Logins) saveListLocked() error {
	var pages [][]byte
	var page bytes.Buffer
	flush := func() {
		if page.Len() > 0 {
			pages = append(pages, append(append([]byte("["), page.Bytes()...), ']'))
			page.Reset()
		}
	}
	for _, entry := range l.entries {
		raw, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		if page.Len()+len(raw)+3 > maxValueLen {
			flush()
		}
		if page.Len() > 0 {
			page.WriteByte(',')
		}
		page.Write(raw)
	}
	flush()
	for at, raw := range pages {
		if at < len(l.pages) && bytes.Equal(l.pages[at], raw) {
			continue
		}
		if err := l.store.Put(loginListID(at), raw, loginListBinding); err != nil {
			return err
		}
	}
	for at := len(pages); at < len(l.pages); at++ {
		if err := l.store.Delete(loginListID(at)); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	l.pages = pages
	return nil
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

func encodeLogin(login Login) ([]byte, error) {
	if len(login.Username) > 2000 || len(login.Password) == 0 || len(login.Password) > 4000 || !utf8.ValidString(login.Username) || !utf8.ValidString(login.Password) {
		return nil, errors.New("invalid login")
	}
	raw, err := json.Marshal(login)
	if err != nil || len(raw) > 8192 {
		return nil, errors.New("invalid login")
	}
	return raw, nil
}

func (l *Logins) Put(origin string, login Login) error {
	id, binding, err := loginIdentity(origin)
	if err != nil {
		return err
	}
	if _, err := encodeLogin(login); err != nil {
		return err
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.loadLocked(); err != nil {
		return err
	}
	if err := l.storeLocked(origin, id, binding, login); err != nil {
		return err
	}
	return l.saveListLocked()
}

// storeLocked saves a login and its entry in the list, which the caller writes.
func (l *Logins) storeLocked(origin, id, binding string, login Login) error {
	at := l.findLocked(origin)
	if at < 0 && len(l.entries) >= MaxLogins {
		return errors.New("too many saved logins")
	}
	if at >= 0 && l.entries[at].Confirm {
		login.Confirm = true
	}
	raw, err := encodeLogin(login)
	if err != nil {
		return err
	}
	if err := l.store.Put(id, raw, binding); err != nil {
		return err
	}
	entry := LoginEntry{Origin: origin, Username: login.Username, Confirm: login.Confirm}
	if at >= 0 {
		l.entries[at] = entry
	} else {
		l.entries = append(l.entries, entry)
	}
	return nil
}

func (l *Logins) Get(origin string) (Login, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.getLocked(origin)
}

func (l *Logins) getLocked(origin string) (Login, error) {
	id, binding, err := loginIdentity(origin)
	if err != nil {
		return Login{}, err
	}
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
	if err := l.loadLocked(); err != nil {
		return err
	}
	err = l.store.Delete(id)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	if at := l.findLocked(origin); at >= 0 {
		l.entries = slices.Delete(l.entries, at, at+1)
		if saved := l.saveListLocked(); saved != nil {
			return saved
		}
	}
	return err
}
