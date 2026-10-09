package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/nativewatch/launchertest"
)

// keyd's signature owns the Keychain items, so no keyd subcommand may start a program its caller
// names: the item helper would see signed keyd as its parent.
func TestKeydStartsNoProgramItsCallerNames(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "ran")
	cmd := exec.Command(self, "native-run")
	cmd.Env = []string{"KEYD_TEST_RUN=1", "LOCALDOT_HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
	events, code := launchertest.Run(t, cmd, "/usr/bin/touch", []string{marker})
	if code != 2 || len(events) != 0 {
		t.Fatalf("keyd native-run exited %d with records %v", code, events)
	}
	if _, err := os.Lstat(marker); !os.IsNotExist(err) {
		t.Fatal("keyd ran the program its caller named")
	}
}
