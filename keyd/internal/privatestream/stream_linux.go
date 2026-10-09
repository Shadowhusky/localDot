package privatestream

import (
	"os"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

// Linux counts one link even for an unnamed pipe or socket, so the kernel's own name for the
// descriptor tells: pipe:[inode] or socket:[inode], where a named FIFO shows its path. A named
// socket is caught by its address.
func anonymous(fd int, _ *syscall.Stat_t) bool {
	target, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(fd))
	return err == nil && (strings.HasPrefix(target, "pipe:[") || strings.HasPrefix(target, "socket:["))
}

// Both ends of a socketpair are Unix sockets whose address is the family alone. Go reports that
// and an empty abstract name alike, as "@"; the kernel's length tells them apart, and an abstract
// socket is reachable by any process in this network namespace.
func unnamedPair(fd int) bool {
	return familyOnly(fd, syscall.SYS_GETSOCKNAME) && familyOnly(fd, syscall.SYS_GETPEERNAME)
}

func familyOnly(fd int, call uintptr) bool {
	var addr syscall.RawSockaddrAny
	size := uint32(syscall.SizeofSockaddrAny)
	_, _, errno := syscall.Syscall(call, uintptr(fd), uintptr(unsafe.Pointer(&addr)), uintptr(unsafe.Pointer(&size)))
	return errno == 0 && addr.Addr.Family == syscall.AF_UNIX && size == uint32(unsafe.Sizeof(addr.Addr.Family))
}
