//go:build linux

package admin

import (
	"net"
	"os"
	"strconv"
	"syscall"

	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// GenuineKeydPeer checks that the process at the other end of conn is a keyd daemon of this user:
// the process that made the socket's listener, running this same executable in daemon mode.
func GenuineKeydPeer(conn *net.UnixConn) error {
	raw, err := conn.SyscallConn()
	if err != nil {
		return vault.ErrNotKeyd
	}
	var cred *syscall.Ucred
	credErr := vault.ErrNotKeyd
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil || credErr != nil || cred == nil || int(cred.Uid) != os.Getuid() || cred.Pid <= 1 {
		return vault.ErrNotKeyd
	}
	return keydProcess("/proc/" + strconv.Itoa(int(cred.Pid)))
}

func keydProcess(proc string) error {
	self, err := os.Stat("/proc/self/exe")
	if err != nil {
		return vault.ErrNotKeyd
	}
	peer, err := os.Stat(proc + "/exe")
	if err != nil || !os.SameFile(self, peer) {
		return vault.ErrNotKeyd
	}
	cmdline, err := os.ReadFile(proc + "/cmdline")
	if err != nil || !daemonArgs(cmdline) {
		return vault.ErrNotKeyd
	}
	return nil
}
