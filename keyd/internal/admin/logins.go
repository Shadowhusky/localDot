package admin

import (
	"errors"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"net/http"
)

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
	}
	if !decode(w, r, &body) {
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	var err error
	switch r.Method {
	case "PUT":
		err = s.Logins.Put(body.Origin, vault.Login{Username: body.Username, Password: body.Password})
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
	if errors.Is(err, vault.ErrNotFound) {
		fail(w, 404, "not-found", "no saved login")
		return
	}
	if errors.Is(err, vault.ErrLocked) {
		failLocked(w)
		return
	}
	if err != nil {
		fail(w, 409, "login-unavailable", "the saved login could not be accessed")
		return
	}
	reply(w, 200, map[string]bool{"ok": true})
}
