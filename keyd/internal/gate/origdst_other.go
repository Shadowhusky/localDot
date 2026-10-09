//go:build !linux

package gate

import (
	"errors"
	"net"
	"net/netip"
)

func OriginalDst(net.Conn) (netip.AddrPort, error) {
	return netip.AddrPort{}, errors.New("gate: redirected connections exist on Linux only")
}
