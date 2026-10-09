// Package tempkeychain makes a real keychain for a test that needs one: unlocked with a random
// password, kept out of the user's keychain search list, and deleted when the test ends. Tests
// that use it are opt-in, since making a keychain touches the search list for a moment.
package tempkeychain

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// New returns the path of a new keychain and its password.
func New(t testing.TB) (string, string) {
	t.Helper()
	secret := make([]byte, 16)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	password := hex.EncodeToString(secret)
	path := filepath.Join(t.TempDir(), "test.keychain")
	list := searchList(t)
	security(t, "create-keychain", "-p", password, path)
	if _, err := os.Stat(path + "-db"); err == nil {
		path += "-db"
	}
	t.Cleanup(func() { security(t, "delete-keychain", path) })
	security(t, append([]string{"list-keychains", "-d", "user", "-s"}, list...)...)
	security(t, "set-keychain-settings", path)
	return path, password
}

// Security runs the security tool, failing the test on an error. Its output never holds a secret
// the test cares about.
func Security(t testing.TB, args ...string) string {
	t.Helper()
	return security(t, args...)
}

func security(t testing.TB, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/security", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("security %s: %v\n%s", args[0], err, out)
	}
	return string(out)
}

func searchList(t testing.TB) []string {
	t.Helper()
	var list []string
	for line := range strings.Lines(security(t, "list-keychains", "-d", "user")) {
		if path := strings.Trim(strings.TrimSpace(line), `"`); path != "" {
			list = append(list, path)
		}
	}
	return list
}
