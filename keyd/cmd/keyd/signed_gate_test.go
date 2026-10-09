package main

import (
	"crypto/rand"
	"encoding/hex"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/nativewatch/launchertest"
	"github.com/shadowhusky/localdot/keyd/internal/tempkeychain"
)

// helperProbe is this test executable acting as a parent of the Keychain helper: it runs the helper
// named by -keyd, hands it -secret on descriptor 3 unless that is empty, and exits with its status.
// Started with flags only, it passes as a keyd daemon; with a leading argument, as a keyd that is
// running a subcommand.
func helperProbe(args []string) int {
	if len(args) > 0 && args[0] == "probe" {
		args = args[1:]
	}
	fs := flag.NewFlagSet("probe", flag.ContinueOnError)
	keyd := fs.String("keyd", "", "")
	op := fs.String("op", "check", "")
	account := fs.String("account", "probe", "")
	secret := fs.String("secret", "", "")
	if fs.Parse(args) != nil {
		return 2
	}
	session, err := hex.DecodeString(*secret)
	if err != nil {
		return 2
	}
	return runHelper(*keyd, *op, *account, session)
}

// runHelper runs the helper as this process's child and returns its exit status.
func runHelper(keyd, op, account string, session []byte) int {
	cmd := exec.Command(keyd, "keychain-item", op, "localdot-keyd-test", account)
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"}
	if path := os.Getenv("KEYD_TEST_KEYCHAIN"); path != "" {
		cmd.Env = append(cmd.Env, "KEYD_TEST_KEYCHAIN="+path)
	}
	if session != nil {
		r, w, err := os.Pipe()
		if err != nil {
			return -1
		}
		w.Write(session)
		w.Close()
		defer r.Close()
		cmd.ExtraFiles = []*os.File{r}
	}
	return exitCode(cmd.Run())
}

func newSession(t *testing.T) []byte {
	t.Helper()
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	return secret
}

// probe runs this executable as another parent of the helper.
func probe(t *testing.T, keyd string, subcommand bool, op, account string, session []byte) int {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"-keyd", keyd, "-op", op, "-account", account, "-secret", hex.EncodeToString(session)}
	if subcommand {
		args = append([]string{"probe"}, args...)
	}
	cmd := exec.Command(self, args...)
	cmd.Env = append(os.Environ(), "KEYD_HELPER_PROBE=1")
	return exitCode(cmd.Run())
}

// KEYD_SIGNED_DIR names a Developer ID build of keyd and keyd-native (scripts/deploy.sh makes one),
// and this test executable must be signed as keyd too, so that it passes as a keyd daemon. The
// identity probes open no keychain; the claim probes use a keychain the test makes.
func TestSignedHelperServesOnlyTheDaemonThatClaimedIt(t *testing.T) {
	dir := os.Getenv("KEYD_SIGNED_DIR")
	if dir == "" {
		t.Skip("needs a signed build in KEYD_SIGNED_DIR, run by a test executable signed as keyd")
	}
	keyd, native := filepath.Join(dir, "keyd"), filepath.Join(dir, "keyd-native")
	session := newSession(t)

	if code := runHelper(keyd, "check", "probe", session); code != 0 {
		t.Fatalf("the helper refused this signed daemon-mode parent: %d", code)
	}
	if code := runHelper(keyd, "check", "probe", nil); code != 45 {
		t.Fatalf("a signed keyd parent without the channel was not refused: %d", code)
	}
	if code := probe(t, keyd, true, "check", "probe", session); code != 45 {
		t.Fatalf("a signed keyd parent running a subcommand was not refused: %d", code)
	}
	direct := exec.Command("/bin/sh", "-c", `exec "$0" keychain-item check localdot-keyd-test probe 3</dev/null`, keyd)
	direct.Env = []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"}
	if code := exitCode(direct.Run()); code != 45 {
		t.Fatalf("a helper started by a shell was not refused: %d", code)
	}
	launched := exec.Command(native, "native-run")
	launched.Env = []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"}
	events, code := launchertest.Run(t, launched, keyd, []string{"keychain-item", "check", "localdot-keyd-test", "probe"})
	if code != 0 || len(events) != 2 || events[1].Event != "retired" || events[1].Code == nil || *events[1].Code != 45 {
		t.Fatalf("the helper under keyd-native was not refused: exit %d, records %v", code, events)
	}
	selfTest := exec.Command(keyd, "self-test", "-home", shortHome(t))
	selfTest.Env = []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"}
	if out, err := selfTest.CombinedOutput(); err != nil {
		t.Fatalf("signed keyd self-test failed: %v\n%s", err, out)
	}

	keychain, _ := tempkeychain.New(t)
	t.Setenv("KEYD_TEST_KEYCHAIN", keychain)
	other := newSession(t)
	if code := runHelper(keyd, "read", "probe", session); code != 45 {
		t.Fatalf("an item operation ran before any claim: %d", code)
	}
	if code := runHelper(keyd, "claim", "_session", session); code != 0 {
		t.Fatalf("this daemon could not claim the service: %d", code)
	}
	if code := runHelper(keyd, "read", "probe", session); code != 44 {
		t.Fatalf("the claiming daemon's read: %d, want 44 (no such item)", code)
	}
	if code := runHelper(keyd, "list", "_all", session); code != 0 {
		t.Fatalf("the claiming daemon's list: %d", code)
	}
	for name, code := range map[string]int{
		"another secret":                 runHelper(keyd, "read", "probe", other),
		"no channel":                     runHelper(keyd, "read", "probe", nil),
		"another daemon with the secret": probe(t, keyd, false, "read", "probe", session),
		"another daemon's claim":         probe(t, keyd, false, "claim", "_session", other),
		"a subcommand parent's claim":    probe(t, keyd, true, "claim", "_session", other),
		"another daemon's adopt":         probe(t, keyd, false, "adopt", "_all", session),
		"another daemon's list":          probe(t, keyd, false, "list", "_all", session),
	} {
		if code != 45 {
			t.Errorf("%s was not refused: %d", name, code)
		}
	}
	if code := runHelper(keyd, "read", "probe", session); code != 44 {
		t.Fatalf("a refused claim displaced this daemon's: %d", code)
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
