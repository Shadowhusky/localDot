// Package admin is keyd's control API: HTTP on a 0600 Unix socket, for the localDot daemon only.
// Secrets arrive sealed to keyd's per-boot key, so the daemon relays them without reading them.
package admin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"regexp"
	"syscall"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const maxBody = 1 << 20

var routeName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type Server struct {
	Manager  *egress.Manager
	Vault    *vault.Vault
	Registry *keys.Registry
	Opener   *vault.Opener
	Settings *llm.Settings
	Budget   *llm.Budget
	Audit    *audit.Log
	Events   *events.Hub
	BootID   string
	Version  string
	Hairpin  *netguard.Public
	Service  *ServiceProcessIdentity
	Push     Pusher
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/status", s.status)
	mux.HandleFunc("GET /v1/secrets", s.listSecrets)
	mux.HandleFunc("PUT /v1/secrets/{id}", s.putSecret)
	mux.HandleFunc("DELETE /v1/secrets/{id}", s.deleteSecret)
	mux.HandleFunc("GET /v1/cells", s.listCells)
	mux.HandleFunc("POST /v1/cells", s.openCell)
	mux.HandleFunc("GET /v1/cells/{id}", s.getCell)
	mux.HandleFunc("DELETE /v1/cells/{id}", s.closeCell)
	mux.HandleFunc("POST /v1/cells/{id}/revoke", s.revoke)
	mux.HandleFunc("POST /v1/cells/{id}/surrogates", s.mint)
	mux.HandleFunc("PUT /v1/cells/{id}/task", s.beginTask)
	mux.HandleFunc("DELETE /v1/cells/{id}/task", s.endTask)
	mux.HandleFunc("GET /v1/cells/{id}/model-admission", s.getModelAdmission)
	mux.HandleFunc("PUT /v1/cells/{id}/model-admission", s.setModelAdmission)
	mux.HandleFunc("GET /v1/budget", s.getBudget)
	mux.HandleFunc("PUT /v1/budget", s.setBudget)
	mux.HandleFunc("GET /v1/llm/routes/{route}/models", s.getModels)
	mux.HandleFunc("PUT /v1/llm/routes/{route}/models", s.setModels)
	mux.HandleFunc("GET /v1/events", s.events)
	mux.HandleFunc("GET /v1/push/key", s.pushKey)
	mux.HandleFunc("POST /v1/push/send", s.pushSend)
	return mux
}

// Listen opens the admin socket readable and writable by this user only, replacing a stale one.
// The caller holds keyd's lock, so no other keyd is using it.
func Listen(path string) (net.Listener, error) {
	if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSocket == 0 {
		return nil, fmt.Errorf("admin socket path is not a socket")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	old := syscall.Umask(0o177)
	ln, err := net.Listen("unix", path)
	syscall.Umask(old)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	return ln, nil
}

func (s *Server) status(w http.ResponseWriter, _ *http.Request) {
	date, spent := s.Budget.Day()
	auditState := map[string]any{"ok": true}
	if err := s.Audit.Err(); err != nil {
		auditState = map[string]any{"ok": false, "error": err.Error()}
	}
	reply(w, http.StatusOK, map[string]any{
		"bootId":  s.BootID,
		"service": s.Service,
		"version": s.Version,
		"sealKey": s.Opener.PublicKey(),
		"cells":   len(s.Manager.Cells()),
		"secrets": len(s.Vault.Records()),
		"reenter": s.reentries(),
		"limits":  s.Settings.Limits(),
		"day":     map[string]any{"date": date, "spentUSD": spent},
		"audit":   auditState,
		"hairpin": s.hairpin(),
	})
}

func (s *Server) hairpin() any {
	if s.Hairpin == nil {
		return nil
	}
	return s.Hairpin.Status()
}

// listedSecret is a record as the admin API lists it: Reenter says the stored value is gone or can
// never be read as it is stored, so the user enters it again.
type listedSecret struct {
	vault.Record
	Reenter bool `json:"reenter,omitempty"`
}

func (s *Server) listSecrets(w http.ResponseWriter, _ *http.Request) {
	records := s.Vault.Records()
	listed := make([]listedSecret, len(records))
	for i, rec := range records {
		listed[i] = listedSecret{Record: rec, Reenter: s.Vault.NeedsReentry(rec.ID)}
	}
	reply(w, http.StatusOK, map[string]any{"secrets": listed})
}

func (s *Server) reentries() int {
	n := 0
	for _, rec := range s.Vault.Records() {
		if s.Vault.NeedsReentry(rec.ID) {
			n++
		}
	}
	return n
}

type putSecretBody struct {
	Kind     vault.Kind   `json:"kind"`
	Provider string       `json:"provider,omitempty"`
	BaseURL  string       `json:"baseURL,omitempty"`
	Hosts    []string     `json:"hosts,omitempty"`
	Header   string       `json:"header,omitempty"`
	Format   string       `json:"format,omitempty"`
	Methods  []string     `json:"methods,omitempty"`
	Paths    []string     `json:"paths,omitempty"`
	Sealed   vault.Sealed `json:"sealed"`
}

// putSecret stores a secret sealed for exactly this record, binding included. Replacing a secret
// revokes the surrogates minted for it. A vault failure is logged, never returned: the error text
// is not the daemon's to see.
func (s *Server) putSecret(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var body putSecretBody
	if !decode(w, r, &body) {
		return
	}
	rec := vault.Record{ID: id, Kind: body.Kind, Provider: body.Provider, BaseURL: body.BaseURL, Hosts: body.Hosts,
		Header: body.Header, Format: body.Format, Methods: body.Methods, Paths: body.Paths}
	if !vault.Writable(id) {
		fail(w, http.StatusBadRequest, "bad-request", fmt.Sprintf("secret id %q is not allowed", id))
		return
	}
	b, err := keys.FromRecord(rec)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad-binding", err.Error())
		return
	}
	value, err := s.Opener.Open(body.Sealed, rec)
	if err != nil {
		fail(w, http.StatusBadRequest, "bad-seal", err.Error())
		return
	}
	if err := keys.ValidValueFor(b, value); err != nil {
		fail(w, http.StatusBadRequest, "bad-value", err.Error())
		return
	}
	revoked, err := s.Manager.PutSecret(rec, value)
	if err != nil {
		log.Printf("keyd: storing secret %s failed", id)
		fail(w, http.StatusInternalServerError, "vault", "the secret could not be stored")
		return
	}
	s.admin("secret-put", id, fmt.Sprintf("%d surrogate(s) revoked", revoked))
	stored, _ := s.Vault.Record(id)
	reply(w, http.StatusOK, stored)
}

func (s *Server) deleteSecret(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	revoked, err := s.Manager.DeleteSecret(id)
	if err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			fail(w, http.StatusNotFound, "not-found", "no such secret")
			return
		}
		fail(w, http.StatusInternalServerError, "vault", "the secret could not be deleted")
		return
	}
	s.admin("secret-delete", id, fmt.Sprintf("%d surrogate(s) revoked", revoked))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listCells(w http.ResponseWriter, _ *http.Request) {
	reply(w, http.StatusOK, map[string]any{"cells": s.Manager.Cells()})
}

func (s *Server) openCell(w http.ResponseWriter, r *http.Request) {
	var req egress.OpenRequest
	if !decode(w, r, &req) {
		return
	}
	opened, err := s.Manager.Open(req)
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusCreated, opened)
}

func (s *Server) getCell(w http.ResponseWriter, r *http.Request) {
	info, ok := s.Manager.Cell(r.PathValue("id"))
	if !ok {
		managerFailure(w, egress.ErrUnknownCell)
		return
	}
	reply(w, http.StatusOK, info)
}

func (s *Server) closeCell(w http.ResponseWriter, r *http.Request) {
	if err := s.Manager.Close(r.PathValue("id")); err != nil {
		managerFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) revoke(w http.ResponseWriter, r *http.Request) {
	n, err := s.Manager.Revoke(r.PathValue("id"))
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"revoked": n})
}

func (s *Server) mint(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Secrets []string `json:"secrets"`
	}
	if !decode(w, r, &body) {
		return
	}
	out, err := s.Manager.Mint(r.PathValue("id"), body.Secrets)
	if err != nil {
		managerFailure(w, err)
		return
	}
	reply(w, http.StatusOK, map[string]any{"surrogates": out})
}

func (s *Server) beginTask(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TaskID    string          `json:"taskId"`
		BudgetUSD json.RawMessage `json:"budgetUSD"`
		Pricing   json.RawMessage `json:"pricing"`
	}
	if !decode(w, r, &body) {
		return
	}
	budgetUSD := 0.0
	if body.BudgetUSD != nil && (bytes.Equal(bytes.TrimSpace(body.BudgetUSD), []byte("null")) || json.Unmarshal(body.BudgetUSD, &budgetUSD) != nil) {
		fail(w, http.StatusBadRequest, "bad-request", "invalid task budget")
		return
	}
	var err error
	if body.Pricing != nil {
		var pricing llm.TaskPricing
		if json.Unmarshal(body.Pricing, &pricing) != nil {
			fail(w, http.StatusBadRequest, "bad-request", "invalid task pricing")
			return
		}
		err = s.Manager.BeginPricedTask(r.PathValue("id"), body.TaskID, budgetUSD, pricing)
	} else {
		err = s.Manager.BeginTask(r.PathValue("id"), body.TaskID, budgetUSD)
	}
	if err != nil {
		managerFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) endTask(w http.ResponseWriter, r *http.Request) {
	if err := s.Manager.EndTask(r.PathValue("id")); err != nil {
		managerFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) getBudget(w http.ResponseWriter, _ *http.Request) {
	l := s.Settings.Limits()
	date, spent := s.Budget.Day()
	reply(w, http.StatusOK, map[string]any{"perTaskUSD": l.PerTaskUSD, "perDayUSD": l.PerDayUSD, "day": map[string]any{"date": date, "spentUSD": spent}})
}

func (s *Server) setBudget(w http.ResponseWriter, r *http.Request) {
	var l llm.Limits
	if !decode(w, r, &l) {
		return
	}
	if err := s.Manager.SetLimits(l); err != nil {
		managerFailure(w, err)
		return
	}
	s.admin("budget-set", "", fmt.Sprintf("$%.2f per task, $%.2f per day", l.PerTaskUSD, l.PerDayUSD))
	s.getBudget(w, r)
}

func (s *Server) getModels(w http.ResponseWriter, r *http.Request) {
	route := r.PathValue("route")
	reply(w, http.StatusOK, map[string]any{"route": route, "models": s.Settings.Models(route)})
}

func (s *Server) setModels(w http.ResponseWriter, r *http.Request) {
	route := r.PathValue("route")
	if !routeName.MatchString(route) {
		fail(w, http.StatusBadRequest, "bad-request", "route names are lowercase ids")
		return
	}
	var body struct {
		Models []llm.Price `json:"models"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := s.Manager.SetModels(route, body.Models); err != nil {
		managerFailure(w, err)
		return
	}
	s.admin("models-set", route, fmt.Sprintf("%d model(s)", len(body.Models)))
	s.getModels(w, r)
}

// events streams every event as one JSON line until the client goes away.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	ch, cancel := s.Events.Subscribe(256)
	defer cancel()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.WriteHeader(http.StatusOK)
	flush := http.NewResponseController(w).Flush
	flush()
	enc := json.NewEncoder(w)
	for {
		select {
		case <-r.Context().Done():
			return
		case e, ok := <-ch:
			if !ok || enc.Encode(e) != nil || flush() != nil {
				return
			}
		}
	}
}

func (s *Server) admin(reason, secretID, detail string) {
	if _, err := s.Audit.Write(audit.Line{Kind: audit.KindAdmin, Decision: audit.Allow, Reason: reason, SecretID: secretID, Detail: detail}); err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
	if err != nil || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		fail(w, http.StatusBadRequest, "bad-request", "expected one JSON object of at most 1 MiB")
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		fail(w, http.StatusBadRequest, "bad-request", err.Error())
		return false
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		fail(w, http.StatusBadRequest, "bad-request", "expected one complete JSON object")
		return false
	}
	return true
}

func managerFailure(w http.ResponseWriter, err error) {
	var bad *egress.RequestError
	switch {
	case errors.Is(err, egress.ErrAdmissionStale), errors.Is(err, egress.ErrAdmissionBusy), errors.Is(err, egress.ErrAdmissionClosed):
		fail(w, http.StatusConflict, "model-admission-conflict", "model admission owner unavailable")
	case errors.Is(err, llm.ErrTaskPricingConflict):
		fail(w, http.StatusConflict, "task-pricing-conflict", "task pricing is immutable")
	case errors.Is(err, llm.ErrTaskChanged):
		fail(w, http.StatusConflict, "conflict", "task attachment changed")
	case errors.Is(err, egress.ErrUnknownCell):
		fail(w, http.StatusNotFound, "not-found", err.Error())
	case errors.Is(err, egress.ErrCellExists), errors.Is(err, egress.ErrPortInUse), errors.Is(err, egress.ErrCellChanged):
		fail(w, http.StatusConflict, "conflict", err.Error())
	case errors.As(err, &bad):
		fail(w, http.StatusBadRequest, "bad-request", err.Error())
	case errors.Is(err, egress.ErrManagerClosed):
		fail(w, http.StatusServiceUnavailable, "unavailable", "keyd is shutting down")
	default:
		fail(w, http.StatusInternalServerError, "internal", "keyd could not complete the request")
	}
}

func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, status int, code, message string) {
	reply(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
