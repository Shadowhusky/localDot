//go:build linux

package gate

import (
	"errors"
	"net"
	"net/netip"
	"syscall"
)

// soOriginalDst is netfilter's SO_ORIGINAL_DST: the address a redirected connection was sent to.
const soOriginalDst = 80

func OriginalDst(conn net.Conn) (netip.AddrPort, error) {
	tc, ok := conn.(*net.TCPConn)
	if !ok {
		return netip.AddrPort{}, errors.New("gate: not a TCP connection")
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return netip.AddrPort{}, err
	}
	var dst netip.AddrPort
	var serr error
	err = raw.Control(func(fd uintptr) {
		// The kernel writes a sockaddr_in, which fits the 16-byte Multiaddr field.
		m, err := syscall.GetsockoptIPv6Mreq(int(fd), syscall.IPPROTO_IP, soOriginalDst)
		if err != nil {
			serr = err
			return
		}
		b := m.Multiaddr
		dst = netip.AddrPortFrom(netip.AddrFrom4([4]byte{b[4], b[5], b[6], b[7]}), uint16(b[2])<<8|uint16(b[3]))
	})
	if err != nil {
		return netip.AddrPort{}, err
	}
	return dst, serr
}
