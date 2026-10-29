package admin

import (
	"net"
	"strings"
)

// verifyPeer is the check a key copy makes of the process at the other end of its socket.
func (s *Server) verifyPeer(conn *net.UnixConn) error {
	if s.VerifyPeer != nil {
		return s.VerifyPeer(conn)
	}
	return GenuineKeydPeer(conn)
}

// daemonArgs reports whether a /proc cmdline is keyd's daemon mode: flags only, never a subcommand.
func daemonArgs(cmdline []byte) bool {
	args := strings.Split(strings.TrimSuffix(string(cmdline), "\x00"), "\x00")
	return args[0] != "" && (len(args) == 1 || strings.HasPrefix(args[1], "-"))
}
