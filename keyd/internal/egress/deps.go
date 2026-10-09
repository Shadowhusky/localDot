package egress

import (
	"context"
	"crypto/x509"
	"net"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/cellca"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// Dialer is satisfied by *netguard.Dialer.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

type Config struct {
	CellID string
	Policy policy.Policy
	// Port 0 picks a free port; tests use it.
	Port int
	// RelayDir, when set, also serves the cell on <RelayDir>/<port>.sock. Docker Engine's
	// containers cannot reach the host's 127.0.0.1, so a gate there mounts this folder instead.
	RelayDir string
	Token    string
	// CA terminates TLS for its hosts; without one nothing is intercepted.
	CA *cellca.CA
}

type Deps struct {
	Registry *keys.Registry
	Vault    *vault.Vault
	Audit    *audit.Log
	Events   *events.Hub
	Dialer   Dialer
	// RootCAs verifies upstream TLS; nil means the system roots.
	RootCAs  *x509.CertPool
	Budget   *llm.Budget
	Settings *llm.Settings
	// Local are the gateway's routes to model servers on the Mac; LocalDialer reaches only them.
	Local       map[string]keys.Binding
	LocalDialer Dialer
}
