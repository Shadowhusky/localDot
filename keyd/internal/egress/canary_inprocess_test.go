package egress

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/canary"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// The direct forward invocation needs only the port for audit attribution. No socket is bound.
type canaryAuditAddress struct{}

func (canaryAuditAddress) Accept() (net.Conn, error) { return nil, errors.New("no listener") }
func (canaryAuditAddress) Close() error              { return nil }
func (canaryAuditAddress) Addr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 4760}
}

func TestCanaryInProcessForward(t *testing.T) {
	for _, fault := range []string{"", "revoked", "audit-closed"} {
		t.Run("path-"+fault, func(t *testing.T) {
			upstream, err := canary.NewEcho()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(upstream.Close)
			store, err := vault.Open(vault.NewMemory(), "")
			if err != nil {
				t.Fatal(err)
			}
			record := vault.Record{ID: "diagnostic", Kind: vault.KindHTTP, Hosts: []string{canary.Host}, Header: "Authorization", Format: "bearer"}
			if err := store.Put(record, []byte(upstream.SyntheticSecret())); err != nil {
				t.Fatal(err)
			}
			binding, err := keys.FromRecord(record)
			if err != nil {
				t.Fatal(err)
			}
			registry := keys.NewRegistry()
			entry, err := registry.Mint("diagnostic-cell", binding)
			if err != nil {
				t.Fatal(err)
			}
			auditPath := filepath.Join(t.TempDir(), "audit.jsonl")
			log, err := audit.Open(auditPath)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { log.Close() })
			deps := Deps{Vault: store, Registry: registry, Audit: log, Events: events.NewHub(), Dialer: upstream, RootCAs: upstream.RootCAs()}
			cell := &Cell{cfg: Config{CellID: "diagnostic-cell"}, deps: deps, ln: canaryAuditAddress{}, gen: newGeneration(deps), intercepted: map[string]bool{canary.Host: true}}
			t.Cleanup(cell.gen.stop)
			if fault == "revoked" {
				registry.RevokeCell(cell.ID())
			}
			if fault == "audit-closed" {
				log.Close()
			}
			target, _ := url.Parse("https://" + canary.Host + upstream.Path())
			request := httptest.NewRequest("GET", target.String(), nil)
			request.Header.Set("Authorization", "Bearer "+entry.Token)
			response := httptest.NewRecorder()
			cell.forward(response, request, route{dest: keys.Dest{Cell: cell.ID(), Scheme: "https", Host: canary.Host}, target: target, line: audit.Line{Kind: audit.KindRequest, Mode: "https", Host: canary.Host, Method: "GET", Path: upstream.Path()}, gen: cell.gen})
			upstream.Close()
			receipt := upstream.Receipt()
			if fault != "" {
				if response.Code == 200 || receipt.Authenticated != 0 || receipt.Reflected != 0 {
					t.Fatal("refused credential use reached upstream")
				}
				return
			}
			if response.Code != 200 || receipt.Authenticated != 1 || receipt.Reflected != 1 || receipt.Active != 0 {
				t.Fatalf("missing completed substitution: status=%d receipt=%+v", response.Code, receipt)
			}
			var result map[string]string
			if json.Unmarshal(response.Body.Bytes(), &result) != nil {
				t.Fatal("invalid reflected JSON")
			}
			if result["challenge"] != upstream.Challenge() || result["authorization"] != "Bearer "+entry.Token || response.Header().Get("X-Canary-Key") != entry.Token {
				t.Fatal("reflection was not scrubbed to the cell surrogate")
			}
			log.Close()
			artifact, err := os.ReadFile(auditPath)
			if err != nil {
				t.Fatal(err)
			}
			observed := response.Body.String() + response.Header().Get("X-Canary-Key") + string(artifact)
			for _, needle := range []string{upstream.SyntheticSecret(), base64.StdEncoding.EncodeToString([]byte(upstream.SyntheticSecret())), hex.EncodeToString([]byte(upstream.SyntheticSecret()))} {
				if strings.Contains(observed, needle) {
					t.Fatal("synthetic key escaped into cell output or audit")
				}
			}
			if !strings.Contains(string(artifact), `"swapped":true`) {
				t.Fatal("substitution not audited")
			}
		})
	}
}
