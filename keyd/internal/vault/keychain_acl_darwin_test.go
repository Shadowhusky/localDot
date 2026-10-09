//go:build darwin && cgo

package vault

import (
	"context"
	"os"
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
	if err != nil || strings.Count(log, "PASS ") != 26 {
		t.Fatalf("native policy fixture: %v\n%s", err, log)
	}
}

// The signed-success path needs a Developer ID build, but the order of the identity gate and its
// signing-information rule are checked here with stand-in processes.
func TestNativeIdentityGate(t *testing.T) {
	log, err := runNativeFixture(t, "testdata/keychain_identity.c")
	if err != nil || strings.Count(log, "PASS ") != 59 {
		t.Fatalf("native identity fixture: %v\n%s", err, log)
	}
}

// The item operations run against a keychain the fixture makes, under ad hoc signatures standing in
// for keyd now and the earlier keyd. It adds a keychain to the user's search list for a moment, so
// it runs only when asked.
func TestNativeItemsAgainstATemporaryKeychain(t *testing.T) {
	if os.Getenv("KEYD_TEMP_KEYCHAIN_TEST") != "1" {
		t.Skip("set KEYD_TEMP_KEYCHAIN_TEST=1 to make a temporary keychain")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	dir := t.TempDir()
	plist := filepath.Join(dir, "Info.plist")
	if err := os.WriteFile(plist, []byte(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>KeydGeneration</key><string>2</string></dict></plist>
`), 0o600); err != nil {
		t.Fatal(err)
	}
	now, earlier := filepath.Join(dir, "now"), filepath.Join(dir, "earlier")
	steps := [][]string{
		{"/usr/bin/clang", "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-Wno-unused-function", "-I.", "testdata/keychain_items.c",
			"-framework", "Security", "-framework", "CoreFoundation", "-Wl,-sectcreate,__TEXT,__info_plist," + plist, "-o", now},
		{"/bin/cp", now, earlier},
		{"/usr/bin/codesign", "-f", "-s", "-", "-i", "keyd-items-fixture", "-r=designated => identifier \"keyd-items-fixture\" and info [KeydGeneration] >= \"2\"", now},
		{"/usr/bin/codesign", "-f", "-s", "-", "-i", "keyd-items-fixture", "-r=designated => identifier \"keyd-items-fixture\"", earlier},
	}
	for _, step := range steps {
		if out, err := exec.CommandContext(ctx, step[0], step[1:]...).CombinedOutput(); err != nil {
			t.Fatalf("%s: %v\n%s", step[0], err, out)
		}
	}
	log, err := exec.CommandContext(ctx, now, filepath.Join(dir, "items.keychain"), earlier).CombinedOutput()
	if err != nil || strings.Count(string(log), "PASS ") != 21 {
		t.Fatalf("native items fixture: %v\n%s", err, log)
	}
}
