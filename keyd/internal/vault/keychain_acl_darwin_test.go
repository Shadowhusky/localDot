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

func TestNativeACLRequirementPolicy(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	output := filepath.Join(t.TempDir(), "acl-policy")
	build := exec.CommandContext(ctx, "/usr/bin/clang", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-I.", "testdata/keychain_acl.c", "-framework", "Security", "-framework", "CoreFoundation", "-o", output)
	if log, err := build.CombinedOutput(); err != nil {
		t.Fatalf("compile native policy fixture: %v\n%s", err, log)
	}
	log, err := exec.CommandContext(ctx, output).CombinedOutput()
	if err != nil || strings.Count(string(log), "PASS ") != 33 {
		t.Fatalf("native policy fixture: %v\n%s", err, log)
	}
}
