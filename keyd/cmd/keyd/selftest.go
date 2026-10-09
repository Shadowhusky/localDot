package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// selfTest checks a build before it replaces a running keyd: the Keychain helper accepts this
// signed keyd as its parent (an identity check that opens no keychain), and a daemon with a
// memory vault starts in a new home and answers its admin socket.
func selfTest(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("keyd self-test", flag.ContinueOnError)
	fs.SetOutput(stderr)
	home := fs.String("home", "", "a new, empty directory for the test's state")
	if err := fs.Parse(args); err != nil || *home == "" || fs.NArg() != 0 {
		fmt.Fprintln(stderr, "keyd self-test wants -home <new empty directory>")
		return 2
	}
	if _, err := os.Lstat(filepath.Join(*home, "keyd")); !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(stderr, "keyd self-test: the home already holds keyd state")
		return 2
	}
	if err := vault.NewKeychain(keychainService).Check(); err != nil {
		fmt.Fprintln(stderr, "keyd self-test: the Keychain helper refused this keyd")
		return 1
	}
	boot, err := serveOnce(*home)
	if err != nil {
		fmt.Fprintf(stderr, "keyd self-test: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "keyd self-test ok version=%s boot=%s\n", version, boot)
	return 0
}

// serveOnce starts a memory-vault daemon in home, asks its admin socket for its status and stops.
func serveOnce(home string) (string, error) {
	d, err := start(Config{Home: home, Vault: "memory", Ports: egress.PortRange{Min: 4760, Max: 4789}})
	if err != nil {
		return "", err
	}
	defer d.Close()
	status, err := adminStatus(d.Socket)
	if err != nil || status.BootID != d.BootID || status.Version != version || !status.Audit.OK {
		return "", errors.New("the admin socket did not report this keyd")
	}
	return d.BootID, nil
}

type selfTestStatus struct {
	BootID  string `json:"bootId"`
	Version string `json:"version"`
	Audit   struct {
		OK bool `json:"ok"`
	} `json:"audit"`
}

func adminStatus(socket string) (selfTestStatus, error) {
	var status selfTestStatus
	client := &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}},
	}
	resp, err := client.Get("http://keyd/v1/status")
	if err != nil {
		return status, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return status, fmt.Errorf("status %d", resp.StatusCode)
	}
	return status, json.NewDecoder(io.LimitReader(resp.Body, 1<<16)).Decode(&status)
}
