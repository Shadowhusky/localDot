package admin

import (
	"context"
	"errors"
	"net/http"

	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/oauth"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// connectOAuth finishes a sign-in: keyd redeems the code itself, so the daemon holds the code for a
// moment and never a token. The access token is stored like any web key bound to the app's host.
func (s *Server) connectOAuth(w http.ResponseWriter, r *http.Request) {
	if s.Tokens == nil {
		fail(w, http.StatusServiceUnavailable, "unavailable", "this keyd redeems no sign-ins")
		return
	}
	id := r.PathValue("id")
	var body struct {
		Hosts  []string `json:"hosts"`
		Header string   `json:"header"`
		Format string   `json:"format"`
		oauth.Grant
	}
	if !decode(w, r, &body) {
		return
	}
	rec := vault.Record{ID: id, Kind: vault.KindHTTP, Hosts: body.Hosts, Header: body.Header, Format: body.Format}
	if !vault.Writable(id) {
		fail(w, http.StatusBadRequest, "bad-request", "this secret id is not allowed")
		return
	}
	if _, err := keys.FromRecord(rec); err != nil {
		fail(w, http.StatusBadRequest, "bad-binding", err.Error())
		return
	}
	if s.locked() {
		failLocked(w)
		return
	}
	err := s.Tokens.Connect(r.Context(), rec, body.Grant, func(rec vault.Record, value []byte) error {
		_, err := s.Manager.PutSecret(rec, value)
		return err
	})
	var bad *oauth.BadGrantError
	var refused *oauth.RefusedError
	switch {
	case err == nil:
		stored, _ := s.Vault.Record(id)
		reply(w, http.StatusOK, describeSecret(stored, s.Vault.Attention(id)))
	case errors.As(err, &bad):
		fail(w, http.StatusBadRequest, "bad-request", err.Error())
	case errors.As(err, &refused):
		fail(w, http.StatusBadGateway, "oauth-refused", refused.Code)
	case errors.Is(err, oauth.ErrUnavailable), errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		fail(w, http.StatusBadGateway, "oauth-unavailable", "the app's sign-in service did not answer")
	case errors.Is(err, vault.ErrLocked):
		failLocked(w)
	default:
		fail(w, http.StatusInternalServerError, "vault", "the sign-in could not be stored")
	}
}

// renewOAuth is the daemon's word that an app refused this secret's token before it should have
// ended: keyd refreshes it, once however many ask.
func (s *Server) renewOAuth(w http.ResponseWriter, r *http.Request) {
	if s.Tokens == nil {
		fail(w, http.StatusServiceUnavailable, "unavailable", "this keyd redeems no sign-ins")
		return
	}
	err := s.Tokens.Renew(r.Context(), r.PathValue("id"))
	state := "fresh"
	switch {
	case err == nil:
	case errors.Is(err, oauth.ErrNotSignedIn):
		fail(w, http.StatusNotFound, "not-found", "keyd keeps no sign-in for this secret")
		return
	case errors.Is(err, oauth.ErrReconnect):
		state = "reconnect"
	default:
		state = "unavailable"
	}
	reply(w, http.StatusOK, map[string]string{"state": state})
}
