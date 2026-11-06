//go:build localdot_acceptance

// A test-only process: real keyd admin, vault, cell listeners and sign-in broker, with one fake app
// on loopback TLS behind them, at the names the daemon's tests use. Only the upstream dial and the
// roots it trusts are injected. It answers the daemon on <home>/keyd/admin.sock as keyd does, and
// says how the app was used at http://127.0.0.1:<control>/state.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/admin"
	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/oauth"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	appHost  = "mcp.fake-app.example.test"
	authHost = "auth.fake-app.example.test"
	verifier = "the-fixture-accepts-any-verifier-of-a-good-length"
)

type loopbackOnly struct{ address string }

func (d loopbackOnly) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil || network != "tcp" || (strings.TrimSuffix(host, ".") != appHost && strings.TrimSuffix(host, ".") != authHost) {
		return nil, errors.New("fixture refuses every other upstream")
	}
	return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp4", d.address)
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "oauth fixture:", err)
		os.Exit(1)
	}
}

// app is the fake app: a token endpoint that rotates strictly, and an MCP server that takes only
// the access token it issued last.
type app struct {
	mu        sync.Mutex
	serial    int
	access    string
	refresh   string
	lifetime  int
	refreshes int
	refused   int
	calls     []string
	revoked   bool
}

func (a *app) issue(w http.ResponseWriter) {
	a.serial++
	a.access = fmt.Sprintf("fake-access-token-%d", a.serial)
	a.refresh = fmt.Sprintf("fake-refresh-token-%d", a.serial)
	reply := map[string]any{"access_token": a.access, "refresh_token": a.refresh, "token_type": "Bearer", "expires_in": a.lifetime}
	if a.serial == 1 {
		reply["email"] = "ada@example.test"
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(reply)
}

func (a *app) token(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	refuse := func() {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
	}
	if r.ParseForm() != nil {
		refuse()
		return
	}
	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		if r.PostForm.Get("code") != "the-code" || len(r.PostForm.Get("code_verifier")) < 43 {
			refuse()
			return
		}
	case "refresh_token":
		a.refreshes++
		if r.PostForm.Get("refresh_token") != a.refresh {
			refuse()
			return
		}
	default:
		refuse()
		return
	}
	a.issue(w)
}

func (a *app) mcp(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	good := got == a.access && got != ""
	if good {
		a.calls = append(a.calls, got)
	} else {
		a.refused++
	}
	a.mu.Unlock()
	if !good {
		http.Error(w, "the token is not good", http.StatusUnauthorized)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	var call struct {
		ID     any    `json:"id"`
		Method string `json:"method"`
	}
	if json.NewDecoder(r.Body).Decode(&call) != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	if call.ID == nil {
		w.WriteHeader(http.StatusAccepted)
		return
	}
	var result any
	switch call.Method {
	case "initialize":
		result = map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "fake", "version": "1"}}
	case "tools/list":
		result = map[string]any{"tools": []any{map[string]any{"name": "whoami", "description": "Who the token belongs to.", "inputSchema": map[string]any{"type": "object"}, "annotations": map[string]any{"readOnlyHint": true}}}}
	case "tools/call":
		// An app that repeats the token it was sent: keyd must not let that reach the daemon.
		result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "your token is " + got}}}
	default:
		result = map[string]any{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": call.ID, "result": result})
}

func (a *app) state(w http.ResponseWriter, _ *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	json.NewEncoder(w).Encode(map[string]any{"refreshes": a.refreshes, "refused": a.refused, "calls": a.calls, "issued": a.serial, "revoked": a.revoked})
}

// control changes the app between test steps: ?revoke=1 ends every token it issued.
func (a *app) control(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r.URL.Query().Get("revoke") == "1" {
		a.access, a.refresh = "", ""
	}
	w.WriteHeader(http.StatusNoContent)
}

func selfSigned(hosts ...string) (tls.Certificate, *x509.CertPool) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(err)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: hosts[0]}, DNSNames: hosts, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	must(err)
	cert, err := x509.ParseCertificate(der)
	must(err)
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, roots
}

func main() {
	home := flag.String("home", "", "owned temporary home")
	ports := flag.String("ports", "4791-4795", "owned test listener range")
	lifetime := flag.Int("lifetime", 3600, "how many seconds an access token lasts")
	flag.Parse()
	var lo, hi int
	_, err := fmt.Sscanf(*ports, "%d-%d", &lo, &hi)
	must(err)
	if *home == "" || lo < 4791 || hi > 4797 || lo > hi {
		must(errors.New("invalid fixture-only configuration"))
	}
	dir := filepath.Join(*home, "keyd")
	must(os.MkdirAll(dir, 0o700))

	fake := &app{lifetime: *lifetime}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /token", fake.token)
	mux.HandleFunc("POST /revoke", func(w http.ResponseWriter, _ *http.Request) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		fake.revoked = true
	})
	mux.HandleFunc("/mcp", fake.mcp)
	cert, roots := selfSigned(appHost, authHost)
	upstream := httptest.NewUnstartedServer(mux)
	upstream.TLS = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
	upstream.StartTLS()
	defer upstream.Close()
	controlMux := http.NewServeMux()
	controlMux.HandleFunc("GET /state", fake.state)
	controlMux.HandleFunc("POST /control", fake.control)
	control := httptest.NewServer(controlMux)
	defer control.Close()

	audited, err := audit.Open(filepath.Join(dir, "audit.jsonl"))
	must(err)
	defer audited.Close()
	store := vault.NewMemory()
	v, err := vault.Open(store, filepath.Join(dir, "secrets.json"))
	must(err)
	opener, err := vault.NewOpener()
	must(err)
	settings, err := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	must(err)
	budget, err := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	must(err)
	dialer := loopbackOnly{upstream.Listener.Addr().String()}
	tokens := oauth.New(oauth.Deps{Store: store, Vault: v, Client: oauth.Client(dialer.DialContext, roots), Audit: audited})
	defer tokens.Close()
	registry := keys.NewRegistry()
	hub := events.NewHub()
	manager := egress.NewManager(egress.ManagerDeps{Deps: egress.Deps{Registry: registry, Vault: v, Audit: audited, Events: hub, Dialer: dialer, RootCAs: roots, Budget: budget, Settings: settings, Tokens: tokens}, Ports: egress.PortRange{Min: lo, Max: hi}, CellsDir: filepath.Join(dir, "cells")})
	defer manager.CloseAll()
	socket := filepath.Join(dir, "admin.sock")
	listener, err := admin.Listen(socket)
	must(err)
	defer os.Remove(socket)
	api := &admin.Server{Manager: manager, Vault: v, Tokens: tokens, Registry: registry, Opener: opener, Settings: settings, Budget: budget, Audit: audited, Events: hub, BootID: "oauthfixture", Version: "fixture"}
	server := &http.Server{Handler: api.Handler(), ReadHeaderTimeout: 10 * time.Second, ErrorLog: log.New(os.Stderr, "", 0)}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	fmt.Fprintf(os.Stderr, "keyd ready socket=%s control=%s\n", socket, control.URL)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
}
