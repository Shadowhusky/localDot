package privatestream

import "syscall"

// A pipe or socket with no name in the filesystem has no links.
func anonymous(_ int, stat *syscall.Stat_t) bool { return stat.Nlink == 0 }

// Both ends of a socketpair are Unix sockets with no address.
func unnamedPair(fd int) bool {
	local, e1 := syscall.Getsockname(fd)
	peer, e2 := syscall.Getpeername(fd)
	l, localUnix := local.(*syscall.SockaddrUnix)
	p, peerUnix := peer.(*syscall.SockaddrUnix)
	return e1 == nil && e2 == nil && localUnix && peerUnix && l.Name == "" && p.Name == ""
}
