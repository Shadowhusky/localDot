package canaryrun

import (
	"os"
	"path/filepath"
	"syscall"
)

// AdoptDirectoryLease binds inherited fd3 to the exact private operation directory and locks
// its open file description. Never LOCK_UN: the parent and child may share the description.
// The diagnostic child retains its descriptor until process exit; a recovery parent opens a
// different description and cannot acquire this lease while that child is still alive.
func AdoptDirectoryLease(directory string, descriptor *os.File) error {
	if descriptor == nil || !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return refused
	}
	canonical, err := filepath.EvalSymlinks(directory)
	if err != nil || canonical != directory {
		return refused
	}
	named, err := os.Lstat(directory)
	if err != nil {
		return refused
	}
	opened, err := descriptor.Stat()
	if err != nil {
		return refused
	}
	for _, info := range []os.FileInfo{named, opened} {
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.IsDir() || info.Mode().Perm() != 0700 || info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 || int(stat.Uid) != os.Getuid() {
			return refused
		}
	}
	if !os.SameFile(named, opened) {
		return refused
	}
	if syscall.Flock(int(descriptor.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) != nil {
		return refused
	}
	return nil
}
