//go:build !darwin && !linux

package admin

import (
	"net"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// GenuineKeydPeer cannot tell a keyd on this system: it refuses every peer.
func GenuineKeydPeer(*net.UnixConn) error { return vault.ErrNotKeyd }
