package vault

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
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
	} {
		var out bytes.Buffer
		status := runKeychainItem(test.args, strings.NewReader(test.input), &out,
			func(string, string, string, []byte) ([]byte, int) {
				t.Fatal("native effect for invalid request")
				return nil, 0
			})
		if status != helperUnchanged || out.Len() != 0 {
			t.Fatal("invalid input was accepted or disclosed")
		}
	}
}

func TestItemHelperSeparatesAbsenceFailureAndSecretOutput(t *testing.T) {
	for _, op := range []string{"store", "read", "delete", "check"} {
		for _, status := range []int{0, 1, helperNotFound, helperUnchanged} {
			var out bytes.Buffer
			input := ""
			if op == "store" {
				input = "fake-value"
			}
			result := runKeychainItem([]string{op, "localdot-keyd", "weather"}, strings.NewReader(input), &out,
				func(o, s, a string, data []byte) ([]byte, int) {
					if o != op || s != "localdot-keyd" || a != "weather" || string(data) != input {
						t.Fatal("request changed")
					}
					if op == "read" {
						return []byte("fake-result"), status
					}
					return nil, status
				})
			want := 1
			if status == 0 {
				want = 0
			} else if status == helperNotFound && op != "store" {
				want = helperNotFound
			} else if status == helperUnchanged {
				want = helperUnchanged
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
		status := runKeychainItem([]string{"read", "localdot-keyd", "weather"}, strings.NewReader(""), &out,
			func(string, string, string, []byte) ([]byte, int) { return data, 0 })
		if (size == 1) != (status == 0) || bytes.Count(data, []byte{0}) != size {
			t.Fatal("unbounded read or uncleared buffer")
		}
	}
	if runKeychainItem([]string{"read", "localdot-keyd", "weather"}, strings.NewReader(""), shortOutput{},
		func(string, string, string, []byte) ([]byte, int) { return []byte("fake"), 0 }) == 0 {
		t.Fatal("short output accepted")
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
