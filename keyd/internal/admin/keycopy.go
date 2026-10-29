package admin

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"time"
	"unicode"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

var (
	errUnreachable     = errors.New("the other dot's key service did not answer")
	errReceiverLocked  = errors.New("the other dot's saved keys are locked")
	errReceiverRefused = errors.New("the other dot's key service refused a key")
)

type copyResult struct {
	Secrets int `json:"secrets"`
	Logins  int `json:"logins"`
	Skipped int `json:"skipped"`
}

// copyKeys gives another dot on this machine this keyd's keys and saved logins. The caller names
// only the other dot's home; this keyd checks that a genuine keyd answers there and seals each key
// to that keyd's own key, so no value passes through the caller or any other process.
func (s *Server) copyKeys(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Home   string `json:"home"`
		Logins *bool  `json:"logins"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !s.otherHome(body.Home) {
		fail(w, http.StatusBadRequest, "bad-request", "home must be another dot's home folder")
		return
	}
	if s.locked() {
		failLocked(w)
		return
	}
	result, err := s.copyTo(filepath.Join(body.Home, "keyd", "admin.sock"), body.Logins == nil || *body.Logins)
	line := audit.Line{Kind: audit.KindAdmin, Decision: audit.Allow, Reason: "keys-copy",
		Detail: fmt.Sprintf("%d key(s) and %d login(s) to %s, %d skipped", result.Secrets, result.Logins, body.Home, result.Skipped)}
	if err != nil {
		line.Decision, line.Detail = audit.Deny, fmt.Sprintf("to %s: %v (%d key(s) and %d login(s) before)", body.Home, err, result.Secrets, result.Logins)
	}
	if _, aerr := s.Audit.Write(line); aerr != nil {
		log.Printf("keyd: audit write failed: %v", aerr)
	}
	switch {
	case err == nil:
		reply(w, http.StatusOK, result)
	case errors.Is(err, vault.ErrNotKeyd):
		fail(w, http.StatusForbidden, "not-keyd", "the other dot's socket is not answered by its key service")
	case errors.Is(err, errReceiverLocked):
		fail(w, http.StatusConflict, "receiver-locked", "the other dot's saved keys are locked; unlock them, then copy again")
	case errors.Is(err, errReceiverRefused):
		fail(w, http.StatusBadGateway, "receiver-refused", fmt.Sprintf("the other dot's key service refused a key after %d key(s) and %d login(s)", result.Secrets, result.Logins))
	case errors.Is(err, vault.ErrLocked):
		failLocked(w)
	default:
		fail(w, http.StatusBadGateway, "unreachable", "the other dot's key service did not answer")
	}
}

// otherHome reports whether home can name another dot: an absolute, clean path whose admin socket
// fits a socket address, and not this keyd's own home under any name.
func (s *Server) otherHome(home string) bool {
	if !filepath.IsAbs(home) || filepath.Clean(home) != home || len(home) > 1024 {
		return false
	}
	for _, r := range home {
		if r == unicode.ReplacementChar || unicode.IsControl(r) {
			return false
		}
	}
	limit := 107
	if runtime.GOOS == "darwin" {
		limit = 103
	}
	if len(filepath.Join(home, "keyd", "admin.sock")) > limit || s.Home == "" || filepath.Clean(s.Home) == home {
		return false
	}
	mine, err := os.Stat(filepath.Join(s.Home, "keyd"))
	if err != nil {
		return false
	}
	theirs, err := os.Stat(filepath.Join(home, "keyd"))
	return err != nil || !os.SameFile(mine, theirs)
}

func (s *Server) locked() bool {
	if s.VaultState == nil {
		return false
	}
	state := s.VaultState().State
	return state == "locked" || state == "setup"
}

// copyTo copies over one connection, checking its peer once connected, again once it has told its
// seal key and again after the last key: a key goes only to the key service that answered.
func (s *Server) copyTo(socket string, logins bool) (copyResult, error) {
	var result copyResult
	conn, err := net.DialTimeout("unix", socket, 5*time.Second)
	if err != nil {
		return result, errUnreachable
	}
	defer conn.Close()
	unix, ok := conn.(*net.UnixConn)
	if !ok || s.verifyPeer(unix) != nil {
		return result, vault.ErrNotKeyd
	}
	peer := &keydPeer{conn: unix, reader: bufio.NewReader(unix)}
	var status struct {
		SealKey string            `json:"sealKey"`
		Vault   *vault.VaultState `json:"vault"`
	}
	if err := peer.do("GET", "/v1/status", nil, &status); err != nil {
		return result, err
	}
	if s.verifyPeer(unix) != nil {
		return result, vault.ErrNotKeyd
	}
	if status.Vault != nil && status.Vault.State != "ready" {
		return result, errReceiverLocked
	}
	for _, rec := range s.Vault.Records() {
		if !vault.Writable(rec.ID) {
			continue
		}
		value, err := s.Vault.Value(rec.ID)
		if errors.Is(err, vault.ErrLocked) {
			return result, err
		}
		if err != nil {
			result.Skipped++
			continue
		}
		sealed, err := vault.Seal(status.SealKey, rec, value)
		clear(value)
		if err != nil {
			return result, errReceiverRefused
		}
		body := putSecretBody{Kind: rec.Kind, Provider: rec.Provider, BaseURL: rec.BaseURL, Hosts: rec.Hosts, Header: rec.Header,
			Format: rec.Format, Methods: rec.Methods, Paths: rec.Paths, Sealed: sealed, Metadata: rec.Metadata}
		if err := peer.do("PUT", "/v1/secrets/"+url.PathEscape(rec.ID), body, nil); err != nil {
			return result, err
		}
		result.Secrets++
	}
	if logins && s.Logins != nil {
		origins, err := s.Logins.List()
		if errors.Is(err, vault.ErrLocked) {
			return result, err
		}
		for _, origin := range origins {
			login, err := s.Logins.Get(origin)
			if errors.Is(err, vault.ErrLocked) {
				return result, err
			}
			if err != nil {
				result.Skipped++
				continue
			}
			body := map[string]string{"origin": origin, "username": login.Username, "password": login.Password}
			if err := peer.do("PUT", "/v1/logins", body, nil); err != nil {
				return result, err
			}
			result.Logins++
		}
	}
	if s.verifyPeer(unix) != nil {
		return result, vault.ErrNotKeyd
	}
	return result, nil
}

// keydPeer speaks HTTP/1.1 to another keyd over the one connection that was checked.
type keydPeer struct {
	conn   *net.UnixConn
	reader *bufio.Reader
}

func (p *keydPeer) do(method, path string, body, out any) error {
	var raw []byte
	if body != nil {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			return errReceiverRefused
		}
		defer clear(raw)
	}
	req, err := http.NewRequest(method, "http://keyd"+path, bytes.NewReader(raw))
	if err != nil {
		return errReceiverRefused
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if p.conn.SetDeadline(time.Now().Add(30*time.Second)) != nil || req.Write(p.conn) != nil {
		return errUnreachable
	}
	resp, err := http.ReadResponse(p.reader, req)
	if err != nil {
		return errUnreachable
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	switch {
	case err != nil:
		return errUnreachable
	case resp.StatusCode != http.StatusOK:
		return errReceiverRefused
	case out != nil && json.Unmarshal(data, out) != nil:
		return errReceiverRefused
	}
	return nil
}
