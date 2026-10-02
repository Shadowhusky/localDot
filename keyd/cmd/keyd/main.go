// Command keyd is localDot's key layer: the only process that holds real secrets. It runs as a
// LaunchAgent, keeps its state in <home>/keyd, and answers the daemon on <home>/keyd/admin.sock.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
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
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const (
	version         = "0.1.0"
	keychainService = "localdot-keyd"
)

type Config struct {
	Home  string
	Vault string
	Ports egress.PortRange
}

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "verify-audit" {
		return verifyAudit(args[1:], stderr)
	}
	fs := flag.NewFlagSet("keyd", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := fs.String("home", defaultHome(), "localDot home; keyd keeps its state in <home>/keyd")
	store := fs.String("vault", "keychain", "where secret values live: keychain, or memory for tests")
	ports := fs.String("ports", "4760-4789", "the listener ports the daemon may ask for")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	portRange, err := parsePorts(*ports)
	if err != nil || (*store != "keychain" && *store != "memory") || fs.NArg() != 0 {
		fmt.Fprintln(stderr, "keyd: -ports wants MIN-MAX and -vault wants keychain or memory")
		return 2
	}
	d, err := start(Config{Home: *home, Vault: *store, Ports: portRange})
	if err != nil {
		fmt.Fprintf(stderr, "keyd: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "keyd ready socket=%s boot=%s\n", d.Socket, d.BootID)
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	<-ctx.Done()
	d.Close()
	return 0
}

type Daemon struct {
	BootID    string
	Socket    string
	lock      *os.File
	log       *audit.Log
	manager   *egress.Manager
	server    *http.Server
	closeOnce sync.Once
	cancel    context.CancelFunc
	handlerMu sync.Mutex
	handlers  sync.WaitGroup
	closing   bool
}

func start(cfg Config) (*Daemon, error) {
	if cfg.Vault != "memory" && cfg.Vault != "keychain" {
		return nil, errors.New("keyd: unknown vault mode")
	}
	dir := filepath.Join(cfg.Home, "keyd")
	if err := privateDir(dir); err != nil {
		return nil, err
	}
	lock, err := lockDir(dir)
	if err != nil {
		return nil, err
	}
	d := &Daemon{BootID: bootID(), Socket: filepath.Join(dir, "admin.sock"), lock: lock}
	if err := d.init(dir, cfg); err != nil {
		d.Close()
		return nil, err
	}
	return d, nil
}

func (d *Daemon) init(dir string, cfg Config) error {
	var err error
	if d.log, err = audit.Open(filepath.Join(dir, "audit.jsonl")); err != nil {
		return err
	}
	var store vault.Store = vault.NewKeychain(keychainService)
	index := filepath.Join(dir, "secrets.json")
	if cfg.Vault == "memory" {
		store, index = vault.NewMemory(), ""
	}
	v, err := vault.Open(store, index)
	if err != nil {
		return err
	}
	opener, err := vault.NewOpener()
	if err != nil {
		return err
	}
	settings, err := llm.OpenSettings(filepath.Join(dir, "settings.json"))
	if err != nil {
		return err
	}
	budget, err := llm.OpenBudget(filepath.Join(dir, "spend.json"), settings.Limits, time.Now)
	if err != nil {
		return err
	}
	// CA files left by an earlier process name CAs that died with it.
	cells := filepath.Join(dir, "cells")
	if err := os.RemoveAll(cells); err != nil {
		return err
	}
	hub := events.NewHub()
	registry := keys.NewRegistry()
	local := keys.LocalRoutes()
	guard := netguard.New(netguard.InterfacePrefixes)
	d.manager = egress.NewManager(egress.ManagerDeps{
		Deps: egress.Deps{
			Registry: registry, Vault: v, Audit: d.log, Events: hub,
			Dialer: &netguard.Dialer{Guard: guard, Resolver: net.DefaultResolver},
			Budget: budget, Settings: settings, Local: local, LocalDialer: egress.PinnedFor(local),
		},
		Ports:    cfg.Ports,
		CellsDir: cells,
	})
	ln, err := admin.Listen(d.Socket)
	if err != nil {
		return err
	}
	api := &admin.Server{Manager: d.manager, Vault: v, Registry: registry, Opener: opener, Settings: settings,
		Budget: budget, Audit: d.log, Events: hub, BootID: d.BootID, Version: version}
	ctx, cancel := context.WithCancel(context.Background())
	d.cancel = cancel
	d.server = &http.Server{
		Handler: d.handle(api.Handler()), BaseContext: func(net.Listener) context.Context { return ctx },
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
		ErrorLog: log.New(io.Discard, "", 0),
	}
	go d.server.Serve(ln)
	_, err = d.log.Write(audit.Line{Kind: audit.KindKeyd, Decision: audit.Allow, Reason: "start", Detail: "boot " + d.BootID + ", version " + version})
	return err
}

// Close stops serving, closes every cell, records the stop and releases the lock.
func (d *Daemon) Close() {
	d.closeOnce.Do(func() {
		d.handlerMu.Lock()
		d.closing = true
		d.handlerMu.Unlock()
		if d.cancel != nil {
			d.cancel()
		}
		if d.server != nil {
			d.server.Close()
		}
		if d.manager != nil {
			d.manager.CloseAll()
		}
		// Server.Close interrupts socket reads but does not wait for handlers.
		// Keep the home lock until every admitted admin mutation has returned.
		d.handlers.Wait()
		if d.log != nil {
			d.log.Write(audit.Line{Kind: audit.KindKeyd, Decision: audit.Allow, Reason: "stop", Detail: "boot " + d.BootID})
			d.log.Close()
		}
		if d.Socket != "" {
			os.Remove(d.Socket)
		}
		if d.lock != nil {
			d.lock.Close()
		}
	})
}

func (d *Daemon) handle(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.handlerMu.Lock()
		if d.closing {
			d.handlerMu.Unlock()
			http.Error(w, "keyd is shutting down", http.StatusServiceUnavailable)
			return
		}
		d.handlers.Add(1)
		d.handlerMu.Unlock()
		defer d.handlers.Done()
		next.ServeHTTP(w, r)
	})
}

// privateDir makes dir if needed and insists that it is this user's and closed to others.
func privateDir(dir string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	info, err := os.Stat(dir)
	if err != nil {
		return err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("%s belongs to another user", dir)
	}
	return os.Chmod(dir, 0o700)
}

// lockDir holds an exclusive flock on <dir>/keyd.lock for the life of the process.
func lockDir(dir string) (*os.File, error) {
	f, err := os.OpenFile(filepath.Join(dir, "keyd.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, fmt.Errorf("keyd is already running for %s", filepath.Dir(dir))
		}
		return nil, err
	}
	if err := f.Truncate(0); err != nil {
		f.Close()
		return nil, err
	}
	fmt.Fprintf(f, "%d\n", os.Getpid())
	return f, nil
}

func verifyAudit(args []string, out io.Writer) int {
	if len(args) > 1 {
		fmt.Fprintln(out, "keyd verify-audit accepts one optional path")
		return 2
	}
	path := filepath.Join(defaultHome(), "keyd", "audit.jsonl")
	if len(args) > 0 {
		path = args[0]
	}
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(out, "keyd: %v\n", err)
		return 1
	}
	defer f.Close()
	n, err := audit.Verify(f)
	if err != nil {
		fmt.Fprintf(out, "keyd: audit broken after %d intact lines: %v\n", n, err)
		return 1
	}
	fmt.Fprintf(out, "audit ok: %d lines\n", n)
	return 0
}

func defaultHome() string {
	if h := os.Getenv("LOCALDOT_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".localdot")
}

func parsePorts(s string) (egress.PortRange, error) {
	loText, hiText, ok := strings.Cut(s, "-")
	lo, err1 := strconv.Atoi(loText)
	hi, err2 := strconv.Atoi(hiText)
	if !ok || err1 != nil || err2 != nil || lo < 1 || hi > 65535 || lo > hi {
		return egress.PortRange{}, fmt.Errorf("bad port range %q", s)
	}
	return egress.PortRange{Min: lo, Max: hi}, nil
}

func bootID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}
