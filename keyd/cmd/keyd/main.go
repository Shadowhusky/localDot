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
	"github.com/shadowhusky/localdot/keyd/internal/installlock"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/nativewatch"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/servicelease"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
	"github.com/shadowhusky/localdot/keyd/internal/webpush"
)

const (
	version         = "0.1.0"
	keychainService = "localdot-keyd"
)

// Keep the managed lease reachable until os.Exit, beyond daemon cleanup and handler drainage.
var managedLifetimeLease *os.File

type Config struct {
	Home  string
	Vault string
	Ports egress.PortRange
	// The zero value asks nobody, as the tests do.
	Discovery netguard.Discovery
	Service   *admin.ServiceIdentity
}

const (
	hairpinEvery = 5 * time.Minute
	hairpinRetry = 30 * time.Second
)

func main() {
	os.Exit(run(os.Args[1:], os.Stderr))
}

func run(args []string, stderr io.Writer) int {
	if len(args) > 0 && args[0] == "native-lock" {
		return nativewatch.RunResourceLock(args[1:], os.NewFile(3, "native-resource-lease"), os.Stdout)
	}
	if len(args) > 0 && args[0] == "native-run" {
		return nativewatch.Run(args[1:], os.NewFile(3, "native-control"), os.NewFile(4, "native-events"), os.Stdin, os.Stdout, os.Stderr, 5)
	}
	if len(args) > 0 && args[0] == "canary-run" {
		return runCanary(args[1:], os.Stdin, os.Stdout)
	}
	if len(args) > 0 && args[0] == "canary-lock" {
		return runCanaryLock(args[1:], os.NewFile(3, "canary-directory"), os.Stdout)
	}
	if len(args) > 0 && args[0] == "service-exec" {
		return servicelease.RunExec(args[1:], stderr)
	}
	if len(args) > 0 && args[0] == "service-lock" {
		return servicelease.RunLock(args[1:], os.NewFile(3, "service.lock"), os.Stdout)
	}
	if len(args) > 0 && args[0] == "keychain-item" {
		return vault.RunKeychainItem(args[1:], os.Stdin, os.Stdout)
	}
	if len(args) > 0 && args[0] == "install-lock" {
		return installlock.Run(args[1:], os.NewFile(3, "install.lock"), os.Stdout, stderr)
	}
	if len(args) > 0 && args[0] == "verify-audit" {
		return verifyAudit(args[1:], stderr)
	}
	fs := flag.NewFlagSet("keyd", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := fs.String("home", defaultHome(), "localDot home; keyd keeps its state in <home>/keyd")
	store := fs.String("vault", "keychain", "where secret values live: keychain, or memory for tests")
	ports := fs.String("ports", "4760-4789", "the listener ports the daemon may ask for")
	natpmp := fs.String("natpmp", "on", "ask the router for the public address keyd denies: on or off")
	stun := fs.String("stun", netguard.DefaultSTUN, "STUN server asked when the router gives no public address, or off")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	portRange, err := parsePorts(*ports)
	if err != nil || (*store != "keychain" && *store != "memory") || (*natpmp != "on" && *natpmp != "off") || fs.NArg() != 0 {
		fmt.Fprintln(stderr, "keyd: -ports wants MIN-MAX, -vault keychain or memory, -natpmp on or off")
		return 2
	}
	service, err := managedServiceFromEnv(os.LookupEnv)
	if err != nil {
		fmt.Fprintln(stderr, "keyd: invalid installed service identity")
		return 2
	}
	if service != nil {
		managedLifetimeLease, err = servicelease.Adopt(*service, "keyd", os.Getenv)
		if err != nil {
			fmt.Fprintln(stderr, "keyd: managed service lifetime lease is missing or not admitted")
			return 1
		}
	}
	discovery := netguard.Discovery{Timeout: 3 * time.Second}
	if *natpmp == "on" {
		discovery.Router = netguard.DefaultGateway
	}
	if *stun != "off" {
		discovery.STUN = *stun
	}
	d, err := start(Config{Home: *home, Vault: *store, Ports: portRange, Discovery: discovery, Service: service})
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
	BootID       string
	Socket       string
	lock         *os.File
	log          *audit.Log
	manager      *egress.Manager
	server       *http.Server
	closeOnce    sync.Once
	cancel       context.CancelFunc
	handlerMu    sync.Mutex
	handlers     sync.WaitGroup
	closing      bool
	public       *netguard.Public
	stopLearning chan struct{}
	learning     sync.WaitGroup
}

func start(cfg Config) (*Daemon, error) {
	if cfg.Vault != "memory" && cfg.Vault != "keychain" {
		return nil, errors.New("keyd: unknown vault mode")
	}
	if cfg.Service != nil {
		value := *cfg.Service
		if !value.Valid() {
			return nil, errors.New("keyd: invalid installed service identity")
		}
		cfg.Service = &value
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
	keychain := vault.NewKeychain(keychainService)
	var store vault.Store = keychain
	index := filepath.Join(dir, "secrets.json")
	if cfg.Vault == "memory" {
		store, index = vault.NewMemory(), ""
	} else if err := keychain.Check(); err != nil {
		return errors.New("keyd: the Keychain vault requires a signed native keyd build")
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
	d.public = &netguard.Public{}
	guard := netguard.New(netguard.WithPublic(netguard.InterfacePrefixes, d.public))
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
		Budget: budget, Audit: d.log, Events: hub, BootID: d.BootID, Version: version, Hairpin: d.public}
	if cfg.Service != nil {
		api.Service = &admin.ServiceProcessIdentity{ServiceIdentity: *cfg.Service, PID: os.Getpid()}
	}
	pushDialer := &netguard.Dialer{Guard: guard, Resolver: net.DefaultResolver}
	taken := func(id string) bool { _, ok := v.Record(id); return ok }
	api.Push = webpush.NewSender(webpush.NewSigner(store, taken, time.Now), webpush.Client(pushDialer.DialContext), d.log)
	ctx, cancel := context.WithCancel(context.Background())
	d.cancel = cancel
	d.server = &http.Server{
		Handler: d.handle(api.Handler()), BaseContext: func(net.Listener) context.Context { return ctx },
		ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
		IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10,
		ErrorLog: log.New(io.Discard, "", 0),
	}
	if cfg.Discovery.Off() {
		d.public.Learn(cfg.Discovery)
	} else {
		d.stopLearning = make(chan struct{})
		logf := func(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }
		d.learning.Add(1)
		go func() {
			defer d.learning.Done()
			d.public.Keep(cfg.Discovery, hairpinEvery, hairpinRetry, d.stopLearning, logf)
		}()
	}
	go d.server.Serve(ln)
	_, err = d.log.Write(audit.Line{Kind: audit.KindKeyd, Decision: audit.Allow, Reason: "start", Detail: "boot " + d.BootID + ", version " + version})
	return err
}

// Close stops serving, closes every cell, records the stop and releases the lock.
func (d *Daemon) Close() {
	d.closeOnce.Do(func() {
		if d.stopLearning != nil {
			close(d.stopLearning)
		}
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
		d.learning.Wait()
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
