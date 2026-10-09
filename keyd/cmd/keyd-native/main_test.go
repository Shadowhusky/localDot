package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/nativewatch/launchertest"
)

func TestMain(m *testing.M) {
	if os.Getenv("KEYD_NATIVE_TEST_RUN") == "1" {
		os.Exit(run(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func TestLauncherRunsTheVerifiedCommand(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "ran")
	cmd := exec.Command(self, "native-run")
	cmd.Env = []string{"KEYD_NATIVE_TEST_RUN=1"}
	events, code := launchertest.Run(t, cmd, "/usr/bin/touch", []string{marker})
	if code != 0 || len(events) != 2 || events[0].Event != "started" || events[1].Event != "retired" ||
		events[1].Code == nil || *events[1].Code != 0 {
		t.Fatalf("native-run exited %d with records %v", code, events)
	}
	if _, err := os.Lstat(marker); err != nil {
		t.Fatal("the command did not run")
	}
}

func TestOnlyTheNativeSubcommandsRun(t *testing.T) {
	for _, args := range [][]string{nil, {"keychain-item", "check", "localdot-keyd", "probe"}, {"-home", t.TempDir()}, {"self-test"}, {"service-exec"}} {
		if code := run(args); code != 2 {
			t.Fatalf("keyd-native %v exited %d", args, code)
		}
	}
}
