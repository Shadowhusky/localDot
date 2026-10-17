package admin

import (
	"errors"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"net/http"
)

type serviceUsage struct {
	Hosts   []string    `json:"hosts"`
	BaseURL string      `json:"baseURL,omitempty"`
	Header  string      `json:"header"`
	Format  keys.Format `json:"format"`
	Methods []string    `json:"methods,omitempty"`
	Paths   []string    `json:"paths,omitempty"`
}

func describeSecret(rec vault.Record, attention vault.Attention) listedSecret {
	result := listedSecret{Record: rec, Reenter: attention == vault.Reenter, Rebound: attention == vault.Rebound}
	if b, err := keys.ServiceBinding(rec); err == nil {
		result.Usage = &serviceUsage{Hosts: b.Hosts, Header: b.Header, Format: b.Format, Methods: b.Methods, Paths: b.Paths}
		if rec.Kind == vault.KindLLM {
			if original, err := keys.FromRecord(rec); err == nil {
				result.Usage.BaseURL = original.Upstream.String()
			}
		}
	}
	return result
}
func (s *Server) putMetadata(w http.ResponseWriter, r *http.Request) {
	var metadata vault.Metadata
	if !decode(w, r, &metadata) {
		return
	}
	if err := metadata.Validate(); err != nil {
		fail(w, 400, "bad-metadata", "invalid key description")
		return
	}
	id := r.PathValue("id")
	if err := s.Vault.SetMetadata(id, metadata); err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			fail(w, 404, "not-found", "no such key")
			return
		}
		fail(w, 500, "vault", "key description could not be saved")
		return
	}
	s.admin("secret-metadata", id, "")
	rec, _ := s.Vault.Record(id)
	reply(w, 200, describeSecret(rec, s.Vault.Attention(id)))
}
