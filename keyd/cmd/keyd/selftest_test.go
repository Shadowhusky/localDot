package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSelfTestServesFromANewHome(t *testing.T) {
	home := shortHome(t)
	boot, err := serveOnce(home)
	if err != nil || len(boot) != 16 {
		t.Fatalf("serveOnce = %q, %v", boot, err)
	}
	if _, err := os.Lstat(filepath.Join(home, "keyd", "admin.sock")); !os.IsNotExist(err) {
		t.Fatal("the self-test left its admin socket behind")
	}
}

func TestSelfTestRefusesAnUnsignedBuildAndAUsedHome(t *testing.T) {
	var diagnostic bytes.Buffer
	if code := selfTest([]string{"-home", t.TempDir()}, &diagnostic); code != 1 || !strings.Contains(diagnostic.String(), "refused") {
		t.Fatalf("unsigned self-test exited %d: %s", code, diagnostic.String())
	}
	used := t.TempDir()
	if err := os.Mkdir(filepath.Join(used, "keyd"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{nil, {"-home", used}, {"-home", t.TempDir(), "extra"}} {
		if code := selfTest(args, &diagnostic); code != 2 {
			t.Fatalf("self-test %v exited %d", args, code)
		}
	}
}
