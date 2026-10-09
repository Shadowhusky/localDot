package vault

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "keychain-item" {
		os.Exit(RunKeychainItem(os.Args[2:], os.Stdin, os.Stdout))
	}
	os.Exit(m.Run())
}

func TestItemHelperRejectsInputBeforeNativeAccess(t *testing.T) {
	for _, test := range []struct {
		args  []string
		input string
	}{
		{nil, ""}, {[]string{"dump", "localdot-keyd", "weather"}, ""},
		{[]string{"read", "other-service", "weather"}, ""},
		{[]string{"read", "localdot-keyd", "weather.6"}, ""},
		{[]string{"read", "localdot-keyd", "weather\n"}, ""},
		{[]string{"store", "localdot-keyd", "weather"}, ""},
		{[]string{"delete", "localdot-keyd", "weather"}, "secret"},
		{[]string{"check", "localdot-keyd", "status"}, "secret"},
		{[]string{"store", "localdot-keyd", "weather"}, strings.Repeat("x", helperItemLimit+1)},
		{[]string{"read", "localdot-keyd", "_session"}, ""},
		{[]string{"store", "localdot-keyd", "_session"}, "keyd-session:1:1:1.000000:0"},
		{[]string{"claim", "localdot-keyd", "weather"}, ""},
		{[]string{"claim", "localdot-keyd", "_bindings"}, ""},
		{[]string{"adopt", "localdot-keyd", "weather"}, ""},
		{[]string{"adopt", "localdot-keyd", "_all"}, "secret"},
		{[]string{"read", "localdot-keyd", "_all"}, ""},
		{[]string{"list", "localdot-keyd", "weather"}, ""},
		{[]string{"list", "localdot-keyd", "_all"}, "secret"},
	} {
		var out bytes.Buffer
		status := runKeychainItem(test.args, session(), strings.NewReader(test.input), &out,
			func(string, string, string, []byte, []byte) ([]byte, adoption, int) {
				t.Fatal("native effect for invalid request")
				return nil, adoption{}, 0
			})
		if status != helperUnchanged || out.Len() != 0 {
			t.Fatal("invalid input was accepted or disclosed")
		}
	}
}

// session is a parent's per-start secret as the helper reads it from descriptor 3.
func session() io.Reader { return bytes.NewReader(testSession) }

var testSession = bytes.Repeat([]byte{7}, sessionBytes)

func TestItemHelperSeparatesAbsenceFailureAndSecretOutput(t *testing.T) {
	for _, op := range []string{"store", "read", "delete", "check"} {
		for _, status := range []int{0, 1, helperNotFound, helperUnchanged, helperNotOurs} {
			var out bytes.Buffer
			input := ""
			if op == "store" {
				input = "fake-value"
			}
			result := runKeychainItem([]string{op, "localdot-keyd", "weather"}, session(), strings.NewReader(input), &out,
				func(o, s, a string, data, secret []byte) ([]byte, adoption, int) {
					if o != op || s != "localdot-keyd" || a != "weather" || string(data) != input || !bytes.Equal(secret, testSession) {
						t.Fatal("request changed")
					}
					if op == "read" {
						return []byte("fake-result"), adoption{}, status
					}
					return nil, adoption{}, status
				})
			want := 1
			if status == 0 {
				want = 0
			} else if status == helperNotFound && op != "store" {
				want = helperNotFound
			} else if status == helperUnchanged || status == helperNotOurs {
				want = status
			}
			if result != want {
				t.Fatalf("%s status %d => %d, want %d", op, status, result, want)
			}
			if op == "read" && status == 0 {
				if out.String() != "fake-result" {
					t.Fatal("missing read")
				}
			} else if out.Len() != 0 {
				t.Fatal("failure disclosed data")
			}
		}
	}
}

type shortOutput struct{}

func (shortOutput) Write(p []byte) (int, error) { return len(p) - 1, nil }

func TestItemHelperBoundsAndClearsReadBytes(t *testing.T) {
	for _, size := range []int{0, 1, helperItemLimit + 1} {
		data := bytes.Repeat([]byte("x"), size)
		var out bytes.Buffer
		status := runKeychainItem([]string{"read", "localdot-keyd", "weather"}, session(), strings.NewReader(""), &out,
			func(string, string, string, []byte, []byte) ([]byte, adoption, int) { return data, adoption{}, 0 })
		if (size == 1) != (status == 0) || bytes.Count(data, []byte{0}) != size {
			t.Fatal("unbounded read or uncleared buffer")
		}
	}
	if runKeychainItem([]string{"read", "localdot-keyd", "weather"}, session(), strings.NewReader(""), shortOutput{},
		func(string, string, string, []byte, []byte) ([]byte, adoption, int) {
			return []byte("fake"), adoption{}, 0
		}) == 0 {
		t.Fatal("short output accepted")
	}
}

// The helper takes the parent's secret only whole: exactly its size, then the end of the channel.
func TestItemHelperReadsTheSessionWhole(t *testing.T) {
	for name, channel := range map[string]io.Reader{
		"whole":      session(),
		"none":       strings.NewReader(""),
		"short":      bytes.NewReader(testSession[1:]),
		"long":       bytes.NewReader(append(bytes.Clone(testSession), 7)),
		"closed fd":  descriptor(1 << 20),
		"unreadable": iotest.ErrReader(errors.New("no channel")),
	} {
		var got []byte
		runKeychainItem([]string{"check", "localdot-keyd", "status"}, channel, strings.NewReader(""), io.Discard,
			func(_, _, _ string, _, secret []byte) ([]byte, adoption, int) {
				got = bytes.Clone(secret)
				return nil, adoption{}, 0
			})
		if (name == "whole") != bytes.Equal(got, testSession) || (name != "whole" && got != nil) {
			t.Fatalf("%s: the helper took %x", name, got)
		}
	}
}

// adopt reports how many items it moved and how many it could not; its other output is never echoed.
func TestItemHelperReportsWhatAdoptMoved(t *testing.T) {
	var out bytes.Buffer
	status := runKeychainItem([]string{"adopt", "localdot-keyd", "_all"}, session(), strings.NewReader(""), &out,
		func(op, _, account string, _, _ []byte) ([]byte, adoption, int) {
			if op != "adopt" || account != "_all" {
				t.Fatal("request changed")
			}
			return []byte("fake-result"), adoption{moved: 3, failed: 2}, 0
		})
	if status != 0 || out.String() != "3 2" {
		t.Fatalf("adopt exited %d with %q", status, out.String())
	}
}

// list names the service's items, an empty list included, and nothing past its bound.
func TestItemHelperListsTheServicesItems(t *testing.T) {
	for _, names := range [][]byte{[]byte("deepseek\nweather\n"), {}, bytes.Repeat([]byte("x"), helperListLimit+1)} {
		var out bytes.Buffer
		status := runKeychainItem([]string{"list", "localdot-keyd", "_all"}, session(), strings.NewReader(""), &out,
			func(op, _, account string, _, _ []byte) ([]byte, adoption, int) {
				if op != "list" || account != "_all" {
					t.Fatal("request changed")
				}
				return bytes.Clone(names), adoption{}, 0
			})
		if fits := len(names) <= helperListLimit; (status == 0) != fits || (fits && !bytes.Equal(out.Bytes(), names)) || (!fits && out.Len() != 0) {
			t.Fatalf("a list of %d bytes exited %d with %d bytes", len(names), status, out.Len())
		}
	}
}

// Each helper the keyd runs gets its per-start secret on descriptor 3, never on its command line.
func TestKeychainHandsEachHelperItsSessionOnDescriptor3(t *testing.T) {
	k, dir := fakeKeychain(t)
	k.session = bytes.Repeat([]byte{0xab}, sessionBytes)
	script := "#!/bin/sh\nod -v -An -tx1 <&3 | tr -d ' \\n' >> \"$FAKE_DIR/session.log\"\necho >> \"$FAKE_DIR/session.log\"\nexit 44\n"
	if err := os.WriteFile(k.Path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather", testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	if err := k.Claim(); err == nil {
		t.Fatal("a refused claim succeeded")
	}
	log, err := os.ReadFile(filepath.Join(dir, "session.log"))
	want := strings.Repeat(strings.Repeat("ab", sessionBytes)+"\n", 2)
	if err != nil || string(log) != want {
		t.Fatalf("the helpers read %q", log)
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if strings.Contains(string(argv), "abab") {
		t.Fatal("the session reached a command line")
	}
}

func TestKeychainSanitizesChildEnvironmentAndUsesOwnExecutable(t *testing.T) {
	k := NewKeychain("localdot-keyd")
	path, _ := os.Executable()
	if k.Path != path || strings.Contains(k.Path, "/usr/bin/security") {
		t.Fatal("wrong ACL owner")
	}
	t.Setenv("LOCALDOT_FAKE_SECRET", "must-not-reach-helper")
	k.configureCommand = func(cmd *exec.Cmd) {
		if strings.Join(cmd.Env, ";") != "PATH=/usr/bin:/bin;LANG=en_US.UTF-8" || cmd.Dir != "/" {
			t.Fatal("ambient environment inherited")
		}
		if strings.Join(cmd.Args[1:], " ") != "keychain-item store localdot-keyd weather.0" {
			t.Fatal("unexpected command")
		}
		cmd.Path = "/nonexistent-keyd-helper"
	}
	if err := k.add(context.Background(), "weather.0", "fake-only"); !errors.Is(err, errUnchanged) {
		t.Fatal("missing executable was not a pre-effect failure")
	}
}

func TestFailedFirstWriteDoesNotClaimUnchanged(t *testing.T) {
	k, _ := fakeKeychain(t)
	err := k.abandon(context.Background(), "weather", false, errors.New("unknown reply"))
	if errors.Is(err, errUnchanged) {
		t.Fatal("uncertain native write claimed unchanged")
	}
}

func TestInvalidReadAndDeleteDoNotRunHelper(t *testing.T) {
	k := NewKeychain("localdot-keyd")
	k.configureCommand = func(*exec.Cmd) { t.Fatal("invalid ID reached helper") }
	if _, err := k.Get("weather.0", testBinding); err == nil {
		t.Fatal("chunk access exposed")
	}
	if err := k.Delete("weather.0"); err == nil {
		t.Fatal("chunk delete exposed")
	}
}

func TestSignedKeychainIdentityCheckOnly(t *testing.T) {
	if os.Getenv("KEYD_SIGNED_IDENTITY_TEST") != "1" {
		t.Skip("requires an explicitly signed fixture; no Keychain item access")
	}
	if err := NewKeychain("localdot-keyd-test").Check(); err != nil {
		t.Fatal(err)
	}
}

func TestCleanupNativeFixture(t *testing.T) {
	id := os.Getenv("KEYD_CLEANUP_TEST_ACCOUNT")
	if id == "" {
		t.Skip("explicit synthetic-item cleanup only")
	}
	if !strings.HasPrefix(id, "probe-") || !idPattern.MatchString(id) {
		t.Fatal("invalid synthetic account")
	}
	k := NewKeychain("localdot-keyd-test")
	k.configureCommand = func(cmd *exec.Cmd) { cmd.Stderr = os.Stderr }
	if err := k.Check(); err != nil {
		t.Fatal(err)
	}
	if err := k.Delete(id); err != nil && !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	for _, account := range append([]string{id}, id+".0", id+".1", id+".2", id+".3", id+".4", id+".5") {
		if _, err := k.find(context.Background(), account); !errors.Is(err, ErrNotFound) {
			t.Fatal("synthetic item remains: " + account)
		}
	}
}

// Adopt takes the helper's two counts, moved and left behind, and nothing else.
func TestKeychainAdoptReadsWhatWasMovedAndWhatWasNot(t *testing.T) {
	k, dir := fakeKeychain(t)
	script := strings.Replace(fakeSecurity, `run "$@"`, `[ "$2" = adopt ] && { cat "$FAKE_DIR/adopt"; exit 0; }; run "$@"`, 1)
	if err := os.WriteFile(k.Path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	for report, want := range map[string][2]int{"3 2": {3, 2}, "0 0": {0, 0}, "3": {-1}, "3 2 1": {-1}, "-1 0": {-1}, "x 0": {-1}, "": {-1}} {
		if err := os.WriteFile(filepath.Join(dir, "adopt"), []byte(report), 0o600); err != nil {
			t.Fatal(err)
		}
		moved, failed, err := k.Adopt()
		if (want[0] < 0) != (err != nil) || (err == nil && (moved != want[0] || failed != want[1])) {
			t.Fatalf("a report of %q: %d moved, %d failed, %v", report, moved, failed, err)
		}
	}
}
