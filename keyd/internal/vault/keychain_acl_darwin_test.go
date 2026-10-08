//go:build darwin && cgo

package vault

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runNativeFixture compiles a C fixture against the native headers and returns its output. The
// fixtures open no Keychain and inspect no signed process.
func runNativeFixture(t *testing.T, source string) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output := filepath.Join(t.TempDir(), "fixture")
	build := exec.CommandContext(ctx, "/usr/bin/clang", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-I.", source, "-framework", "Security", "-framework", "CoreFoundation", "-o", output)
	if log, err := build.CombinedOutput(); err != nil {
		t.Fatalf("compile %s: %v\n%s", source, err, log)
	}
	log, err := exec.CommandContext(ctx, output).CombinedOutput()
	return string(log), err
}

func TestNativeACLRequirementPolicy(t *testing.T) {
	log, err := runNativeFixture(t, "testdata/keychain_acl.c")
	if err != nil || strings.Count(log, "PASS ") != 34 {
		t.Fatalf("native policy fixture: %v\n%s", err, log)
	}
}

// The signed-success path needs a Developer ID build, but the order of the identity gate and its
// signing-information rule are checked here with stand-in processes.
func TestNativeIdentityGate(t *testing.T) {
	log, err := runNativeFixture(t, "testdata/keychain_identity.c")
	if err != nil || strings.Count(log, "PASS ") != 15 {
		t.Fatalf("native identity fixture: %v\n%s", err, log)
	}
}
