package canaryrun

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func leaseDirectory(t *testing.T) (string, *os.File) {
	t.Helper()
	path, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	return path, file
}

func TestDirectoryLeaseSurvivesUntilLastSharedDescriptorCloses(t *testing.T) {
	path, parent := leaseDirectory(t)
	if err := AdoptDirectoryLease(path, parent); err != nil {
		t.Fatal(err)
	}
	fd, err := syscall.Dup(int(parent.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	child := os.NewFile(uintptr(fd), "inherited-directory")
	defer child.Close()
	if err := AdoptDirectoryLease(path, child); err != nil {
		t.Fatal("shared descriptor refused", err)
	}
	parent.Close()
	recovery, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer recovery.Close()
	if AdoptDirectoryLease(path, recovery) == nil {
		t.Fatal("recovery admitted while child retained lease")
	}
	child.Close()
	if err := AdoptDirectoryLease(path, recovery); err != nil {
		t.Fatal("lease not released after last descriptor closed", err)
	}
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) != 0 {
		t.Fatal("lease created an artifact in the empty operation directory")
	}
}

func TestDirectoryLeaseRefusesUnsafeIdentity(t *testing.T) {
	for _, fault := range []string{"nil", "closed", "other-directory", "relative", "unclean", "symlink", "public", "sticky", "file"} {
		t.Run(fault, func(t *testing.T) {
			path, file := leaseDirectory(t)
			switch fault {
			case "nil":
				file = nil
			case "closed":
				file.Close()
			case "other-directory":
				_, file = leaseDirectory(t)
			case "relative":
				path = "relative"
			case "unclean":
				path += "/."
			case "symlink":
				link := filepath.Join(t.TempDir(), "link")
				if err := os.Symlink(path, link); err != nil {
					t.Fatal(err)
				}
				path = link
			case "public":
				if err := os.Chmod(path, 0755); err != nil {
					t.Fatal(err)
				}
			case "sticky":
				if err := os.Chmod(path, 0700|os.ModeSticky); err != nil {
					t.Fatal(err)
				}
			case "file":
				path = filepath.Join(path, "file")
				var err error
				file, err = os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0700)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
			}
			if AdoptDirectoryLease(path, file) == nil {
				t.Fatal("unsafe lease accepted")
			}
		})
	}
}

func TestDirectoryLeaseAllowsRetainedRecoveryArtifacts(t *testing.T) {
	path, file := leaseDirectory(t)
	if err := os.WriteFile(filepath.Join(path, "audit"), []byte("retained"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := AdoptDirectoryLease(path, file); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(path, "audit"))
	if err != nil || string(data) != "retained" {
		t.Fatal("recovery lease modified artifacts")
	}
}
