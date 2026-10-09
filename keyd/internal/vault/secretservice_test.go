package vault

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeSecretTool answers like libsecret's secret-tool, keeping items as files: lookup of a missing
// item exits 1 and prints nothing. FAKE_FAIL=store fails a store after printing its input;
// FAKE_FAIL=locked fails everything the way a locked keyring does.
const fakeSecretTool = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/argv.log"
mkdir -p "$FAKE_DIR/items"
op=$1; shift
case "$op" in store) shift ;; esac
[ "$1" = service ] && [ "$3" = account ] || { echo "secret-tool: bad attributes" >&2; exit 2; }
[ $# = 4 ] || [ "$5" = part ] || { echo "secret-tool: bad attributes" >&2; exit 2; }
item="$FAKE_DIR/items/$2.$4.$6"
if [ "$FAKE_FAIL" = locked ]; then echo "secret-tool: Cannot create an item in a locked collection" >&2; exit 1; fi
case "$op" in
  store)
    data=$(cat)
    if [ ${#data} -gt 8191 ]; then echo "secret-tool: password is too long" >&2; exit 1; fi
    if [ "$FAKE_FAIL" = store ] && [ "$6" = head ]; then echo "secret-tool: refused $data" >&2; exit 1; fi
    printf '%s' "$data" > "$item" ;;
  lookup) [ -f "$item" ] || exit 1; cat "$item" ;;
  clear) if [ $# = 4 ]; then rm -f "$FAKE_DIR/items/$2.$4".*; else rm -f "$item"; fi ;;
  *) exit 2 ;;
esac
`

func fakeSecretService(t *testing.T) (*SecretService, string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "secret-tool")
	if err := os.WriteFile(bin, []byte(fakeSecretTool), 0o700); err != nil {
		t.Fatal(err)
	}
	s := &SecretService{Service: "localdot-keyd-test", tool: tool{
		path: bin,
		env:  []string{"PATH=/usr/bin:/bin", "DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent"},
		configureCommand: func(cmd *exec.Cmd) {
			cmd.Env = append(cmd.Env, "FAKE_DIR="+dir, "FAKE_FAIL="+os.Getenv("FAKE_FAIL"))
		},
	}}
	return s, dir
}

func TestSecretServiceStoresBoundValues(t *testing.T) {
	s, dir := fakeSecretService(t)
	if err := s.Check(); err != nil {
		t.Fatal(err)
	}
	value := longValue(maxValueLen)
	if err := s.Put("weather", value, testBinding); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get("weather", testBinding)
	if err != nil || !bytes.Equal(got, value) {
		t.Fatalf("Get = %d bytes, %v", len(got), err)
	}
	other := bindingOf(Record{ID: "weather", Kind: KindHTTP, Hosts: []string{"evil.example.test"}, Header: "X-Api-Key", Format: "raw"})
	if _, err := s.Get("weather", other); !errors.Is(err, errRebound) {
		t.Fatalf("a value was served for another binding: %v", err)
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if carries(string(argv), value) {
		t.Fatal("the value travelled in argv")
	}
	if err := s.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("weather", testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted item still reads: %v", err)
	}
	if err := s.Delete("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v, want ErrNotFound", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, "items")); len(entries) != 0 {
		t.Fatalf("items left behind: %v", entries)
	}
}

func TestSecretServiceFailuresNeverCarryTheValue(t *testing.T) {
	s, dir := fakeSecretService(t)
	if err := s.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_FAIL", "store")
	err := s.Put("weather", []byte("another-secret-value"), testBinding)
	if err == nil || errors.Is(err, errUnchanged) || carries(err.Error(), []byte("another-secret-value")) {
		t.Fatalf("failed store: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, "items")); len(entries) != 0 {
		t.Fatalf("an uncertain store left parts for the vault to guess about: %v", entries)
	}
	t.Setenv("FAKE_FAIL", "locked")
	if _, err := s.Get("weather", testBinding); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("a locked keyring read as a missing item: %v", err)
	}
	if err := s.Delete("weather"); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("a locked keyring deleted as missing: %v", err)
	}
	if s.Check() == nil {
		t.Fatal("a locked keyring passed the check")
	}
}

func TestSecretServiceRefusesForeignItems(t *testing.T) {
	s, dir := fakeSecretService(t)
	if err := os.MkdirAll(filepath.Join(dir, "items"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "items", "localdot-keyd-test.weather.0"), []byte("0011:6869"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, head := range []string{"plain-password", "keyd:2:0011:9:" + testBinding, "keyd:1:0011:1:" + testBinding, "keyd:2:0022:1:" + testBinding} {
		if err := os.WriteFile(filepath.Join(dir, "items", "localdot-keyd-test.weather.head"), []byte(head), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get("weather", testBinding); err == nil {
			t.Fatalf("read a foreign or torn item %q", head)
		}
	}
}

func TestSecretServiceUnavailableWithoutToolOrBus(t *testing.T) {
	s, _ := fakeSecretService(t)
	s.tool.env = []string{"PATH=/usr/bin:/bin"}
	if s.Check() == nil {
		t.Fatal("no session bus passed the check")
	}
	s, _ = fakeSecretService(t)
	s.tool.path = ""
	if s.Check() == nil {
		t.Fatal("no secret-tool passed the check")
	}
	s, _ = fakeSecretService(t)
	s.tool.timeout = 100 * time.Millisecond
	if err := os.WriteFile(s.tool.path, []byte("#!/bin/sh\nexec sleep 5\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if s.Check() == nil || time.Since(started) > 2*time.Second {
		t.Fatal("a keyring that never answers was not cut off at its deadline")
	}
}

func TestSecretServiceEnvironmentIsSessionOnly(t *testing.T) {
	env := sessionEnv(func(name string) string {
		return map[string]string{
			"XDG_RUNTIME_DIR":          "/run/user/1000",
			"DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
			"OPENAI_API_KEY":           "must-not-reach",
			"LD_PRELOAD":               "/tmp/hook.so",
		}[name]
	})
	joined := strings.Join(env, ";")
	if joined != "PATH=/usr/bin:/bin;LANG=C.UTF-8;XDG_RUNTIME_DIR=/run/user/1000;DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus" {
		t.Fatalf("env = %s", joined)
	}
	if strings.Contains(strings.Join(sessionEnv(func(string) string { return "relative\n" }), ";"), "relative") {
		t.Fatal("an unsafe value reached the child")
	}
}

// TestRealSecretService runs against the session's keyring; the Linux test image provides one.
func TestRealSecretService(t *testing.T) {
	if os.Getenv("KEYD_SECRET_SERVICE_IT") != "1" {
		t.Skip("needs a Secret Service session (KEYD_SECRET_SERVICE_IT=1)")
	}
	s := NewSecretService("localdot-keyd-test", os.Getenv)
	if err := s.Check(); err != nil {
		t.Fatal(err)
	}
	value := longValue(maxValueLen)
	if err := s.Put("it-weather", value, testBinding); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get("it-weather", testBinding)
	if err != nil || !bytes.Equal(got, value) {
		t.Fatalf("Get = %d bytes, %v", len(got), err)
	}
	if _, err := s.Get("it-weather", bindingOf(httpRecord("other"))); !errors.Is(err, errRebound) {
		t.Fatalf("rebound read = %v", err)
	}
	if _, err := s.Get("it-missing", testBinding); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing read = %v", err)
	}
	if err := s.Delete("it-weather"); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("it-weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
	v, _ := openTemp(t, s)
	if err := v.Put(httpRecord("it-vault"), fakeValue); err != nil {
		t.Fatal(err)
	}
	if got, err := v.Value("it-vault"); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("vault read = %q, %v", got, err)
	}
	if err := v.Delete("it-vault"); err != nil {
		t.Fatal(err)
	}
}

func TestSecretServiceShorterValueLeavesNoOldParts(t *testing.T) {
	s, dir := fakeSecretService(t)
	if err := s.Put("weather", longValue(maxValueLen), testBinding); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, "items")); len(entries) != maxServiceParts+1 {
		t.Fatalf("a full value took %d items, want %d", len(entries), maxServiceParts+1)
	}
	if err := s.Put("weather", fakeValue, testBinding); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(dir, "items")); len(entries) != 2 {
		t.Fatalf("old parts stayed: %v", entries)
	}
	if got, err := s.Get("weather", testBinding); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
}
