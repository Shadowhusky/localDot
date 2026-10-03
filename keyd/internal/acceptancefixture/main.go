//go:build localdot_acceptance

// A test-only process: real keyd admin, cell gateway, vault and durable accounting. Only the
// upstream dial is injected, and can reach this process's owned loopback TLS provider only.
package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/admin"
	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const providerHost = "provider.example.test"
const canary = "task15-local-canary-never-real"

type loopbackOnly struct{ address string }

func (d loopbackOnly) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if network != "tcp" || (address != providerHost+":443" && address != providerHost+".:443") {
		return nil, errors.New("fixture refuses every other upstream")
	}
	host, _, err := net.SplitHostPort(d.address)
	if err != nil || host != "127.0.0.1" {
		return nil, errors.New("fixture target is not loopback")
	}
	return (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp4", d.address)
}
func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "acceptance fixture:", err)
		os.Exit(1)
	}
}
func main() {
	home := flag.String("home", "", "owned temporary home")
	ports := flag.String("ports", "4791-4795", "owned test listener range")
	mode := flag.String("vault", "memory", "test memory vault only")
	nat := flag.String("natpmp", "off", "must remain off")
	stun := flag.String("stun", "off", "must remain off")
	flag.Parse()
	var lo, hi int
	_, err := fmt.Sscanf(*ports, "%d-%d", &lo, &hi)
	must(err)
	if *home == "" || *mode != "memory" || *nat != "off" || *stun != "off" || lo < 4791 || hi > 4796 || lo > hi {
		must(errors.New("invalid fixture-only configuration"))
	}
	dir := filepath.Join(*home, "keyd")
	must(os.MkdirAll(dir, 0700))
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	must(err)
	certificate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: providerHost}, DNSNames: []string{providerHost}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, certificate, certificate, &key.PublicKey, key)
	must(err)
	cert, err := x509.ParseCertificate(der)
	must(err)
	upstream := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer "+canary {
			http.Error(w, "fixture authentication refused", 401)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err != nil {
			http.Error(w, "fixture read failed", 400)
			return
		}
		var request map[string]any
		if json.Unmarshal(body, &request) != nil {
			http.Error(w, "invalid fixture request", 400)
			return
		}
		input := 5
		if request["model"] == "fixture-priced" {
			input = 400
			if strings.Contains(string(body), "charge-two") {
				input = 200
			}
		}
		delta := map[string]any{"role": "assistant", "tool_calls": []any{map[string]any{"index": 0, "id": "fixture_done", "type": "function", "function": map[string]any{"name": "done", "arguments": "{\"summary\":\"Done in a cell\"}"}}}}
		chunk := map[string]any{"id": "fixture-response", "object": "chat.completion.chunk", "created": 1, "model": request["model"], "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": "tool_calls"}}, "usage": map[string]any{"prompt_tokens": input, "completion_tokens": 0, "total_tokens": input}}
		encoded, _ := json.Marshal(chunk)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
	}))
	upstream.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}, MinVersion: tls.VersionTLS12}
	upstream.StartTLS()
	defer upstream.Close()
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	log, err := audit.Open(filepath.Join(dir, "audit.jsonl"))
	must(err)
	defer log.Close()
	v, err := vault.Open(vault.NewMemory(), "")
	must(err)
	opener, err := vault.NewOpener()
	must(err)
	settings, err := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	must(err)
	budget, err := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	must(err)
	registry := keys.NewRegistry()
	hub := events.NewHub()
	manager := egress.NewManager(egress.ManagerDeps{Deps: egress.Deps{Registry: registry, Vault: v, Audit: log, Events: hub, Dialer: loopbackOnly{upstream.Listener.Addr().String()}, RootCAs: roots, Budget: budget, Settings: settings}, Ports: egress.PortRange{Min: lo, Max: hi}, CellsDir: filepath.Join(dir, "cells")})
	defer manager.CloseAll()
	random := make([]byte, 8)
	_, err = rand.Read(random)
	must(err)
	boot := hex.EncodeToString(random)
	socket := filepath.Join(dir, "admin.sock")
	listener, err := admin.Listen(socket)
	must(err)
	defer os.Remove(socket)
	api := &admin.Server{Manager: manager, Vault: v, Registry: registry, Opener: opener, Settings: settings, Budget: budget, Audit: log, Events: hub, BootID: boot, Version: "task15-fixture"}
	server := &http.Server{Handler: api.Handler(), ReadHeaderTimeout: 10 * time.Second}
	defer server.Close()
	go func() { _ = server.Serve(listener) }()
	fmt.Fprintf(os.Stderr, "keyd ready socket=%s boot=%s\n", socket, boot)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
}
