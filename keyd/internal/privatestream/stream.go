//go:build darwin || linux

// Package privatestream accepts anonymous inherited IPC streams, including Node/libuv's Unix
// socketpairs. It excludes regular files, named FIFOs, named sockets and IP sockets.
package privatestream

import (
	"errors"
	"os"
	"syscall"
	"time"
)

var ErrStream = errors.New("a private inherited stream is required")

// Duplicate owns a poller-backed copy. Callers retain ownership of the original file, but must
// not concurrently use it: the shared open file description is made nonblocking. Both the
// original and duplicate are marked close-on-exec; otherwise the original inherited descriptor
// would survive Go's exec even though its duplicate is protected. Explicit child stdio mappings
// still work because exec duplicates those mappings onto descriptors 0, 1 and 2.
func Duplicate(file *os.File) (*os.File, error) {
	if file == nil {
		return nil, ErrStream
	}
	info, err := file.Stat()
	if err != nil {
		return nil, ErrStream
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Nlink != 0 || int(stat.Uid) != os.Getuid() {
		return nil, ErrStream
	}
	fd := int(file.Fd())
	switch info.Mode() & os.ModeType {
	case os.ModeNamedPipe:
	case os.ModeSocket:
		local, e1 := syscall.Getsockname(fd)
		peer, e2 := syscall.Getpeername(fd)
		typeID, e3 := syscall.GetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_TYPE)
		l, localUnix := local.(*syscall.SockaddrUnix)
		p, peerUnix := peer.(*syscall.SockaddrUnix)
		if e1 != nil || e2 != nil || e3 != nil || !localUnix || !peerUnix || l.Name != "" || p.Name != "" || typeID != syscall.SOCK_STREAM {
			return nil, ErrStream
		}
	default:
		return nil, ErrStream
	}
	syscall.CloseOnExec(fd)
	copyFD, err := syscall.Dup(fd)
	if err != nil {
		return nil, ErrStream
	}
	syscall.CloseOnExec(copyFD)
	if syscall.SetNonblock(copyFD, true) != nil {
		_ = syscall.Close(copyFD)
		return nil, ErrStream
	}
	copy := os.NewFile(uintptr(copyFD), "private-inherited-stream")
	if copy.SetReadDeadline(time.Time{}) != nil || copy.SetWriteDeadline(time.Time{}) != nil {
		_ = copy.Close()
		return nil, ErrStream
	}
	return copy, nil
}

// OpenEmpty probes a fresh lifetime stream without blocking or changing its deadline. A known
// closed writer or any unexpected data refuses task creation. It never returns consumed data.
func OpenEmpty(file *os.File) bool {
	if file == nil {
		return false
	}
	conn, err := file.SyscallConn()
	if err != nil {
		return false
	}
	var probe error
	err = conn.Control(func(fd uintptr) { var data [1]byte; _, probe = syscall.Read(int(fd), data[:]) })
	return err == nil && errors.Is(probe, syscall.EAGAIN)
}
