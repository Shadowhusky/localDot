package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/nativewatch/launchertest"
)

// KEYD_SIGNED_DIR names a Developer ID build of keyd and keyd-native (scripts/deploy.sh makes
// one). Every probe asks the item helper for its identity check alone, which opens no keychain.
func TestSignedHelperServesOnlyTheDaemon(t *testing.T) {
	dir := os.Getenv("KEYD_SIGNED_DIR")
	if dir == "" {
		t.Skip("needs a signed build in KEYD_SIGNED_DIR")
	}
	keyd, native := filepath.Join(dir, "keyd"), filepath.Join(dir, "keyd-native")
	check := []string{"keychain-item", "check", "localdot-keyd-test", "probe"}
	env := []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"}

	direct := exec.Command(keyd, check...)
	direct.Env = env
	if err := direct.Run(); exitCode(err) != 45 {
		t.Fatalf("a direct helper call was not refused: %v", err)
	}

	launched := exec.Command(native, "native-run")
	launched.Env = env
	events, code := launchertest.Run(t, launched, keyd, check)
	if code != 0 || len(events) != 2 || events[1].Event != "retired" || events[1].Code == nil || *events[1].Code != 45 {
		t.Fatalf("the helper under keyd-native was not refused: exit %d, records %v", code, events)
	}

	selfTest := exec.Command(keyd, "self-test", "-home", shortHome(t))
	selfTest.Env = env
	if out, err := selfTest.CombinedOutput(); err != nil {
		t.Fatalf("signed keyd self-test failed: %v\n%s", err, out)
	}
}

func exitCode(err error) int {
	if exit, ok := err.(*exec.ExitError); ok {
		return exit.ExitCode()
	}
	if err == nil {
		return 0
	}
	return -1
}
