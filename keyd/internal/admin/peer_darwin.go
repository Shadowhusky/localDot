//go:build darwin

package admin

import (
	"net"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// GenuineKeydPeer checks that the process at the other end of conn is a keyd daemon of this user.
func GenuineKeydPeer(conn *net.UnixConn) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return vault.ErrNotKeyd
	}
	verified := vault.ErrNotKeyd
	if err := raw.Control(func(fd uintptr) { verified = vault.VerifyKeydPeer(int(fd)) }); err != nil {
		return vault.ErrNotKeyd
	}
	return verified
}
