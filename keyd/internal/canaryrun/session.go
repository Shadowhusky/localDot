// Package canaryrun owns a separate synthetic gateway for an installed diagnostic run.
// It never opens the user's vault or changes the ordinary keyd service.
package canaryrun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/canary"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

var refused = errors.New("canary gateway could not be confirmed")
var cellPattern = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
var runPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type Config struct{ Directory, CellID, RunID string }
type Ready struct {
	V               int    `json:"v"`
	Type            string `json:"type"`
	RunID           string `json:"runId"`
	CellID          string `json:"cellId"`
	Port            int    `json:"port"`
	ProxyToken      string `json:"proxyToken"`
	CACertPEM       string `json:"caCertPem"`
	Surrogate       string `json:"surrogate"`
	SyntheticSecret string `json:"syntheticSecret"`
	URL             string `json:"url"`
	Challenge       string `json:"challenge"`
}
type Closed struct {
	V             int            `json:"v"`
	Type          string         `json:"type"`
	RunID         string         `json:"runId"`
	CellID        string         `json:"cellId"`
	GatewayClosed bool           `json:"gatewayClosed"`
	Echo          canary.Receipt `json:"echo"`
}
type manager interface {
	Open(egress.OpenRequest) (egress.Opened, error)
	Close(string) error
	CloseAll()
}
type Session struct {
	config  Config
	ready   Ready
	echo    *canary.Echo
	manager manager
	audit   *audit.Log
	once    sync.Once
	closed  Closed
	err     error
}

// Start requires an empty, canonical, private directory already owned by the caller's durable
// diagnostic journal. Artifacts remain for scanning after process exit; this never removes it.
func Start(ctx context.Context, config Config) (*Session, error) {
	return start(ctx, config, func(d egress.ManagerDeps) manager { return egress.NewManager(d) })
}

func start(ctx context.Context, config Config, factory func(egress.ManagerDeps) manager) (_ *Session, err error) {
	if ctx.Err() != nil || !cellPattern.MatchString(config.CellID) || !runPattern.MatchString(config.RunID) {
		return nil, refused
	}
	if err := privateEmpty(config.Directory); err != nil {
		return nil, refused
	}
	directory := filepath.Join(config.Directory, "gateway")
	if os.Mkdir(directory, 0700) != nil {
		return nil, refused
	}
	parent, err := os.Open(config.Directory)
	if err != nil {
		return nil, refused
	}
	err = parent.Sync()
	closeErr := parent.Close()
	if err != nil || closeErr != nil {
		return nil, refused
	}
	s := &Session{config: config}
	defer func() {
		if err != nil {
			s.Close()
		}
	}()
	if s.echo, err = canary.NewEcho(); err != nil {
		return nil, refused
	}
	if s.audit, err = audit.Open(filepath.Join(directory, "audit.jsonl")); err != nil {
		return nil, refused
	}
	store, err := vault.Open(vault.NewMemory(), "")
	if err != nil {
		return nil, refused
	}
	record := vault.Record{ID: "diagnostic", Kind: vault.KindHTTP, Hosts: []string{canary.Host}, Header: "Authorization", Format: "bearer", Methods: []string{"GET"}, Paths: []string{s.echo.Path()}}
	if err := store.Put(record, []byte(s.echo.SyntheticSecret())); err != nil {
		return nil, refused
	}
	settings, err := llm.OpenSettings(filepath.Join(directory, "settings.json"))
	if err != nil {
		return nil, refused
	}
	budget, err := llm.OpenBudget(filepath.Join(directory, "spend.json"), settings.Limits, time.Now)
	if err != nil {
		return nil, refused
	}
	s.manager = factory(egress.ManagerDeps{Deps: egress.Deps{
		Vault: store, Registry: keys.NewRegistry(), Audit: s.audit, Events: events.NewHub(),
		Dialer: s.echo, RootCAs: s.echo.RootCAs(), Budget: budget, Settings: settings,
	}, Ports: egress.PortRange{}, CellsDir: filepath.Join(directory, "cells")})
	if ctx.Err() != nil {
		return nil, refused
	}
	opened, err := s.manager.Open(egress.OpenRequest{CellID: config.CellID, Role: "desktop", Port: 0, Secrets: []string{"diagnostic"}})
	if err != nil || ctx.Err() != nil {
		return nil, refused
	}
	if opened.CellID != config.CellID || opened.Port < 1024 || opened.Port > 65535 || opened.Surrogates["diagnostic"] == "" {
		return nil, refused
	}
	s.ready = Ready{V: 1, Type: "ready", RunID: config.RunID, CellID: config.CellID,
		Port: opened.Port, ProxyToken: opened.ProxyToken, CACertPEM: opened.CACertPEM,
		Surrogate: opened.Surrogates["diagnostic"], SyntheticSecret: s.echo.SyntheticSecret(),
		URL: "https://" + canary.Host + s.echo.Path(), Challenge: s.echo.Challenge()}
	return s, nil
}

func privateEmpty(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return refused
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || canonical != path {
		return refused
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return refused
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return refused
	}
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		return refused
	}
	return nil
}

func (s *Session) Ready() Ready { return s.ready }

// Close retires admission and upstream pipes, then closes audit output. The parent must still
// await this process's actual exit before scanning artifacts: a receipt is not process drainage.
func (s *Session) Close() (Closed, error) {
	s.once.Do(func() {
		s.closed = Closed{V: 1, Type: "closed", RunID: s.config.RunID, CellID: s.config.CellID}
		if s.manager != nil {
			if err := s.manager.Close(s.config.CellID); err != nil {
				s.err = refused
			}
			s.manager.CloseAll()
			s.closed.GatewayClosed = s.err == nil
		}
		if s.echo != nil {
			s.echo.Close()
			s.closed.Echo = s.echo.Receipt()
		}
		if s.audit != nil {
			if err := s.audit.Close(); err != nil {
				s.err = refused
			}
		}
	})
	return s.closed, s.err
}
