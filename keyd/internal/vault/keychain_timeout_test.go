package vault

import (
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestKeychainStalledCommandsHaveAnOperationDeadline(t *testing.T) {
	for _, operation := range []string{"put", "get", "delete"} {
		t.Run(operation, func(t *testing.T) {
			k, _ := fakeKeychain(t)
			k.timeout = 100 * time.Millisecond
			// exec replaces the shell: no detached child survives the deadline.
			if err := os.WriteFile(k.Path, []byte("#!/bin/sh\nexec sleep 5\n"), 0o700); err != nil {
				t.Fatal(err)
			}
			started := time.Now()
			var err error
			switch operation {
			case "put":
				err = k.Put("weather", fakeValue)
			case "get":
				_, err = k.Get("weather")
			case "delete":
				err = k.Delete("weather")
			}
			if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
				t.Fatalf("%s exceeded one deadline: %v", operation, elapsed)
			}
			if err == nil || errors.Is(err, ErrNotFound) || errors.Is(err, errUnchanged) || carries(err.Error(), fakeValue) {
				t.Fatalf("%s did not report a bounded, uncertain failure: %v", operation, err)
			}
		})
	}
}

func TestKeychainSharesItsDeadlineAcrossCommands(t *testing.T) {
	for _, operation := range []string{"put", "get", "delete"} {
		t.Run(operation, func(t *testing.T) {
			k, _ := fakeKeychain(t)
			if err := k.Put("weather", longValue(maxValueLen)); err != nil {
				t.Fatal(err)
			}
			// Every individual command finishes well inside the deadline. A
			// fresh deadline per chunk would let the whole operation run too long.
			script := strings.Replace(fakeSecurity, "store=", "sleep 0.09\nstore=", 1)
			if err := os.WriteFile(k.Path, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			k.timeout = 220 * time.Millisecond
			started := time.Now()
			var err error
			switch operation {
			case "put":
				err = k.Put("weather", longValue(maxValueLen))
			case "get":
				_, err = k.Get("weather")
			case "delete":
				err = k.Delete("weather")
			}
			if elapsed := time.Since(started); elapsed > 500*time.Millisecond || err == nil {
				t.Fatalf("%s did not share its deadline: %v, %v", operation, elapsed, err)
			}
		})
	}
}

func TestTimedOutFirstChunkDoesNotClaimTheOldValueIsUnchanged(t *testing.T) {
	k, dir := fakeKeychain(t)
	v, err := Open(k, dir+"/index.json")
	if err != nil {
		t.Fatal(err)
	}
	rec := Record{ID: "weather", Kind: KindHTTP}
	if err := v.Put(rec, fakeValue); err != nil {
		t.Fatal(err)
	}
	// Simulate a tool that changed its first chunk and then hung before
	// reporting success. The next invocation works so rollback can restore it.
	preamble := `#!/bin/sh
if [ "$1" = "-i" ] && [ ! -f "$FAKE_DIR/stalled" ]; then
  IFS= read -r line
  printf 'interrupted-new-value' > "$FAKE_DIR/store/localdot-keyd-test.weather.0"
  touch "$FAKE_DIR/stalled"
  exec sleep 5
fi
`
	if err := os.WriteFile(k.Path, []byte(preamble+fakeSecurity), 0o700); err != nil {
		t.Fatal(err)
	}
	k.timeout = 600 * time.Millisecond
	if err := v.Put(rec, []byte("replacement-fake-key-value")); err == nil || errors.Is(err, errUnchanged) {
		t.Fatalf("timed-out first chunk claimed no change: %v", err)
	}
	// Reopen so a cached value cannot hide corrupt bytes in the Keychain.
	v, err = Open(k, dir+"/index.json")
	if err != nil {
		t.Fatal(err)
	}
	if got, err := v.Value("weather"); err != nil || string(got) != string(fakeValue) {
		t.Fatalf("old value did not survive rollback and restart: %v", err)
	}
}

func TestKeychainOutputIsBoundedEvenThroughCopy(t *testing.T) {
	var out keychainOutput
	// io.Copy must not discover an embedded bytes.Buffer.ReadFrom and bypass
	// the bound on Write.
	if _, err := io.Copy(&out, struct{ io.Reader }{strings.NewReader(strings.Repeat("sensitive", 4096))}); err == nil {
		t.Fatal("unbounded security output was accepted")
	}
	k, _ := fakeKeychain(t)
	script := "#!/bin/sh\nprintf '%s' '" + strings.Repeat("sensitive", 1000) + "'\n"
	if err := os.WriteFile(k.Path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather"); err == nil || strings.Contains(err.Error(), "sensitive") {
		t.Fatalf("oversized output was exposed or accepted: %v", err)
	}
}

func TestKeychainDoesNotWaitForAnInheritedPipe(t *testing.T) {
	k, dir := fakeKeychain(t)
	script := "#!/bin/sh\nsleep 5 &\nprintf '%s' $! > \"$FAKE_DIR/child.pid\"\nexit 0\n"
	if err := os.WriteFile(k.Path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		data, _ := os.ReadFile(dir + "/child.pid")
		pid, _ := strconv.Atoi(string(data))
		if pid > 0 {
			if child, err := os.FindProcess(pid); err == nil {
				_ = child.Kill()
			}
		}
	})
	started := time.Now()
	if _, err := k.Get("weather"); err == nil || time.Since(started) > 500*time.Millisecond {
		t.Fatalf("security's inherited pipe kept the read alive: %v", err)
	}
}
