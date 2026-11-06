package admin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// An export is at most 4 MiB, which seals to under 5.4 MiB.
const maxImportBody = 6 << 20

// Private Unix-socket transport for the daemon's secure answer channel. These values
// never enter the surrogate registry, cell API, model tools or audit payloads.
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if s.Logins == nil {
		fail(w, 503, "unavailable", "saved logins unavailable")
		return
	}
	var body struct {
		Origin   string `json:"origin"`
		Username string `json:"username"`
		Password string `json:"password"`
		Confirm  bool   `json:"confirm"`
	}
	if !decode(w, r, &body) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var err error
	switch r.Method {
	case "PUT":
		err = s.Logins.Put(body.Origin, vault.Login{Username: body.Username, Password: body.Password, Confirm: body.Confirm})
	case "DELETE":
		err = s.Logins.Delete(body.Origin)
	default:
		var login vault.Login
		login, err = s.Logins.Get(body.Origin)
		if err == nil {
			reply(w, 200, login)
			return
		}
	}
	if s.loginFailed(w, err) {
		return
	}
	reply(w, 200, map[string]bool{"ok": true})
}

// loginFailed answers a store's refusal; false when there is none.
func (s *Server) loginFailed(w http.ResponseWriter, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, vault.ErrNotFound):
		fail(w, 404, "not-found", "no saved login")
	case errors.Is(err, vault.ErrLocked):
		failLocked(w)
	default:
		fail(w, 409, "login-unavailable", "the saved login could not be accessed")
	}
	return true
}

// What Settings lists: sites and accounts, never a password.
func (s *Server) listLogins(w http.ResponseWriter, _ *http.Request) {
	if s.Logins == nil {
		fail(w, 503, "unavailable", "saved logins unavailable")
		return
	}
	entries, err := s.Logins.Entries()
	if s.loginFailed(w, err) {
		return
	}
	if entries == nil {
		entries = []vault.LoginEntry{}
	}
	w.Header().Set("Cache-Control", "no-store")
	reply(w, 200, map[string]any{"logins": entries})
}

// Whether a page's site has a saved login, without the password leaving the store.
func (s *Server) findLogin(w http.ResponseWriter, r *http.Request) {
	if s.Logins == nil {
		fail(w, 503, "unavailable", "saved logins unavailable")
		return
	}
	var body struct {
		Origin string `json:"origin"`
	}
	if !decode(w, r, &body) {
		return
	}
	entry, err := s.Logins.Find(body.Origin)
	if s.loginFailed(w, err) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	reply(w, 200, entry)
}

// A login added or edited in Settings, sealed in the page so the daemon relays only ciphertext.
// Without a password it changes the account of the login saved for that site.
func (s *Server) putSealedLogin(w http.ResponseWriter, r *http.Request) {
	if s.Logins == nil {
		fail(w, 503, "unavailable", "saved logins unavailable")
		return
	}
	var body struct {
		Sealed vault.Sealed `json:"sealed"`
	}
	if !decode(w, r, &body) {
		return
	}
	plain, err := s.Opener.OpenLogin(body.Sealed)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad-seal", err.Error())
		return
	}
	defer clear(plain)
	var given struct {
		Origin   string  `json:"origin"`
		Username string  `json:"username"`
		Password *string `json:"password"`
	}
	dec := json.NewDecoder(bytes.NewReader(plain))
	dec.DisallowUnknownFields()
	if dec.Decode(&given) != nil {
		fail(w, http.StatusBadRequest, "bad-login", "the sealed login could not be read")
		return
	}
	login := vault.Login{Username: given.Username, Confirm: true}
	if given.Password != nil {
		login.Password = *given.Password
	} else {
		held, err := s.Logins.Get(given.Origin)
		if s.loginFailed(w, err) {
			return
		}
		login.Password = held.Password
	}
	if !vault.TypableLogin(login) {
		fail(w, http.StatusBadRequest, "bad-login", "check the site, the account and the password")
		return
	}
	err = s.Logins.Put(given.Origin, login)
	if errors.Is(err, vault.ErrLocked) {
		failLocked(w)
		return
	}
	if err != nil {
		fail(w, http.StatusBadRequest, "bad-login", "check the site, the account and the password")
		return
	}
	s.admin("login-saved", "", "a saved login was added or changed")
	entry, err := s.Logins.Find(given.Origin)
	if s.loginFailed(w, err) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	reply(w, 200, entry)
}

type importSkip struct {
	Reason string `json:"reason"`
	Count  int    `json:"count"`
	Lines  []int  `json:"lines"`
}

// A password manager's export, sealed in the page: only this process ever reads it, keeps a login's
// site, account and password, and drops the rest. Its answer has counts and line numbers, never a
// cell, and nothing about it is written anywhere but the protected store.
func (s *Server) importLogins(w http.ResponseWriter, r *http.Request) {
	if s.Logins == nil {
		fail(w, 503, "unavailable", "saved logins unavailable")
		return
	}
	var body struct {
		Sealed vault.Sealed `json:"sealed"`
	}
	if !decodeUpTo(w, r, &body, maxImportBody) {
		return
	}
	plain, err := s.Opener.OpenLoginImport(body.Sealed)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad-seal", err.Error())
		return
	}
	defer clear(plain)
	export, err := vault.ParseLoginExport(plain)
	if err != nil {
		fail(w, http.StatusUnprocessableEntity, "not-an-export", "this file doesn't look like a password export")
		return
	}
	saved, already, err := s.Logins.Import(export.Logins)
	if errors.Is(err, vault.ErrLocked) {
		failLocked(w)
		return
	}
	s.admin("login-import", "", fmt.Sprintf("%d of %d row(s) imported", saved, export.Rows))
	if err != nil {
		fail(w, http.StatusInternalServerError, "vault", fmt.Sprintf("stopped after saving %d login(s)", saved))
		return
	}
	skipped := []importSkip{}
	for reason, lines := range export.Skipped {
		skipped = append(skipped, importSkip{Reason: reason, Count: len(lines), Lines: vault.ListedLines(lines)})
	}
	sort.Slice(skipped, func(a, b int) bool { return skipped[a].Reason < skipped[b].Reason })
	w.Header().Set("Cache-Control", "no-store")
	reply(w, 200, map[string]any{"rows": export.Rows, "imported": saved, "alreadySaved": len(already), "skipped": skipped})
}
