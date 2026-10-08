// Package installlock holds the installer mutex without starting keyd, opening the vault,
// or contacting Docker. The lock file is permanent: unlinking it would split the mutex.
package installlock

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
)

var ErrUnsafe = errors.New("installation lock directory or file is unsafe")
var ErrBusy = errors.New("another installation operation holds the lock")
var noncePattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var ownerPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// Acquire requires an existing canonical private directory. The caller must preserve ownership
// of the directory until the returned descriptor closes. Same-user adversarial processes are
// outside this filesystem boundary. No stale-PID probing or lock-file removal is performed.
func Acquire(directory string) (*os.File, error) {
	return acquire(directory, "install.lock")
}

func serviceName(owner, role string) (string, error) {
	if !ownerPattern.MatchString(owner) || (role != "keyd" && role != "daemon") {
		return "", ErrUnsafe
	}
	return "service-" + owner + "-" + role + ".lock", nil
}

// Service locks are permanent, independent from the installation-operation lock, and stable
// across releases. They are held by the actual app process until it exits.
func AcquireService(directory, owner, role string) (*os.File, error) {
	name, err := serviceName(owner, role)
	if err != nil {
		return nil, err
	}
	return acquire(directory, name)
}

func LockInheritedService(directory, owner, role string, file *os.File) error {
	name, err := serviceName(owner, role)
	if err != nil {
		return err
	}
	return lockInherited(directory, name, file)
}

func acquire(directory, name string) (*os.File, error) {
	path := filepath.Join(directory, name)
	// Validate before creating a file, then validate again under the descriptor lock.
	if _, err := privateDirectory(directory); err != nil {
		return nil, err
	}
	fd, err := syscall.Open(path, syscall.O_RDWR|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, ErrUnsafe
	}
	file := os.NewFile(uintptr(fd), path)
	if err := lockInherited(directory, name, file); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func privateDirectory(directory string) (os.FileInfo, error) {
	if !filepath.IsAbs(directory) || filepath.Clean(directory) != directory || directory == "/" {
		return nil, ErrUnsafe
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil || canonical != directory {
		return nil, ErrUnsafe
	}
	info, err := os.Lstat(directory)
	if err != nil || !safe(info, true) {
		return nil, ErrUnsafe
	}
	return info, nil
}

// LockInherited applies flock to an inherited open file description. Closing the helper's
// descriptor does not release the lock while the installer still holds its original descriptor.
// Do not issue LOCK_UN here. The caller closes its descriptor only after all install effects drain.
func LockInherited(directory string, file *os.File) error {
	return lockInherited(directory, "install.lock", file)
}

func lockInherited(directory, name string, file *os.File) error {
	info, err := privateDirectory(directory)
	if err != nil {
		return err
	}
	if file == nil {
		return ErrUnsafe
	}
	path := filepath.Join(directory, name)
	opened, err := file.Stat()
	if err != nil || !safe(opened, false) {
		return ErrUnsafe
	}
	named, err := os.Lstat(path)
	if err != nil || !safe(named, false) || !os.SameFile(opened, named) {
		return ErrUnsafe
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return ErrBusy
		}
		return err
	}
	// Observe identity again after acquiring; never authorize a replacement inode or directory.
	afterDir, err := os.Lstat(directory)
	if err != nil || !safe(afterDir, true) || !os.SameFile(info, afterDir) {
		return ErrUnsafe
	}
	after, err := os.Lstat(path)
	if err != nil || !safe(after, false) || !os.SameFile(opened, after) {
		return ErrUnsafe
	}
	return nil
}

func safe(info os.FileInfo, directory bool) bool {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != os.Getuid() {
		return false
	}
	if directory {
		return info.IsDir() && uint32(st.Mode)&0o7777 == 0o700
	}
	return info.Mode().IsRegular() && st.Nlink == 1 && uint32(st.Mode)&0o7777 == 0o600 && info.Size() == 0
}

// Run accepts only the installer-owned inherited descriptor, no executable or command. The helper
// exits after acknowledging acquisition; the kernel lock remains owned by the parent's descriptor.
func Run(args []string, inherited *os.File, output, stderr io.Writer) int {
	if len(args) != 2 || !noncePattern.MatchString(args[1]) {
		fmt.Fprintln(stderr, "keyd install-lock requires a private directory and handshake nonce")
		return 2
	}
	err := LockInherited(args[0], inherited)
	if err != nil {
		if errors.Is(err, ErrBusy) {
			fmt.Fprintln(stderr, "another installation operation is running")
			return 73
		}
		fmt.Fprintln(stderr, "installation lock is unavailable or unsafe")
		return 1
	}
	if _, err := fmt.Fprintf(output, "locked:%s\n", args[1]); err != nil {
		return 1
	}
	return 0
}
