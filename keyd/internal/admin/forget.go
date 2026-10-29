package admin

import (
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// forgetVault deletes everything this keyd keeps in its vault, for a dot that is being removed:
// every key, with its surrogates revoked, every saved login, the push key and, on the Keychain,
// keyd's claim last. keyd keeps running holding nothing until it is stopped.
func (s *Server) forgetVault(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Confirm string `json:"confirm"`
	}
	if !decode(w, r, &body) {
		return
	}
	if body.Confirm != "forget" {
		fail(w, http.StatusBadRequest, "bad-request", `confirm with {"confirm":"forget"}`)
		return
	}
	if s.locked() {
		failLocked(w)
		return
	}
	logins := 0
	if s.Logins != nil {
		origins, err := s.Logins.List()
		if errors.Is(err, vault.ErrLocked) {
			failLocked(w)
			return
		}
		logins = len(origins)
	}
	secrets := 0
	for _, rec := range s.Vault.Records() {
		_, err := s.Manager.DeleteSecret(rec.ID)
		if errors.Is(err, vault.ErrLocked) {
			failLocked(w)
			return
		}
		if err != nil && !errors.Is(err, vault.ErrNotFound) {
			s.forgetFailed(w, secrets)
			return
		}
		secrets++
	}
	rest, err := s.Vault.Forget()
	if errors.Is(err, vault.ErrLocked) {
		failLocked(w)
		return
	}
	if err != nil {
		s.forgetFailed(w, secrets)
		return
	}
	secrets += rest
	s.admin("vault-forget", "", fmt.Sprintf("%d key(s) and %d login(s) forgotten", secrets, logins))
	reply(w, http.StatusOK, map[string]int{"secrets": secrets, "logins": logins})
}

func (s *Server) forgetFailed(w http.ResponseWriter, secrets int) {
	line := audit.Line{Kind: audit.KindAdmin, Decision: audit.Deny, Reason: "vault-forget",
		Detail: fmt.Sprintf("stopped after %d key(s): the vault could not be cleared", secrets)}
	if _, err := s.Audit.Write(line); err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
	fail(w, http.StatusInternalServerError, "vault", "the key vault could not be cleared; try again")
}
