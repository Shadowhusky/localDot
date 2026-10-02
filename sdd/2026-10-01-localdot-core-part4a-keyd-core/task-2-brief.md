### Task 2: The vault — secret records, the Keychain and in-memory stores

The spec puts real secrets in "macOS Keychain items owned by keyd" and nowhere else. The vault
keeps each value in a `Store` — the login keychain in production, memory in tests — and the
secret's metadata (kind, provider, the hosts and header it is bound to) in an index file that never
holds a value. The Keychain store drives `/usr/bin/security`: values travel hex-encoded on its
stdin (`security -i`), never on its command line, where any process could read them (P4a-R3).
`security -i` runs only the first 4,095 characters of a line as one command and the rest as another,
which it prints in its error (review 1, C1). So a value goes in chunks of 1,536 bytes, one item
each (`<id>.0`, `<id>.1`, …), and the item `<id>` names their count and the write that made them,
so a read never mixes two writes; every write is read back, and an error names only the operation,
the item and the exit status, never what the tool printed. A fake `security` script that splits long
lines as the real one does pins that, and one opt-in test stores an 8,192-byte value in the real
login keychain.

**Files:**
- Create: `keyd/internal/vault/store.go`, `keyd/internal/vault/keychain.go`, `keyd/internal/vault/vault.go`
- Test: `keyd/internal/vault/vault_test.go`, `keyd/internal/vault/keychain_test.go`

**Interfaces:**
- Produces: `Store interface { Put(id string, value []byte) error; Get(id string) ([]byte, error); Delete(id string) error }`,
  `ErrNotFound`, `NewMemory() *Memory`, `NewKeychain(service string) *Keychain` (fields `Service`,
  `Path`; items `<id>` = `keyd:<write id>:<chunks>` and `<id>.<n>` = `<write id>:<hex>`, every
  write read back, errors without the tool's output); `Kind` (`KindLLM = "llm"`, `KindHTTP = "http"`);
  `Record{ID, Kind, Provider, BaseURL, Hosts, Header, Format, Methods, Paths, CreatedAt, UpdatedAt}`
  (JSON `id kind provider baseURL hosts header format methods paths createdAt updatedAt`);
  `ValidID(id string) bool` (`^[a-z0-9][a-z0-9_-]{0,63}$`, not `lmstudio` or `ollama`);
  `ValidValue(value []byte) error` (8–8192 bytes of printable ASCII, no leading or trailing
  space); `Open(store Store, indexPath string) (*Vault, error)` (empty path: index in memory);
  `(*Vault).Put(rec Record, value []byte) error`, `Delete(id) error`, `Record(id) (Record, bool)`,
  `Records() []Record` (sorted by id), `Value(id) ([]byte, error)` (reads the store once, then
  caches).

- [ ] **Step 1: Write the failing tests**

`keyd/internal/vault/vault_test.go`:
```go
package vault

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var fakeValue = []byte("real-secret-value-for-test")

func openTemp(t *testing.T, store Store) (*Vault, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "secrets.json")
	v, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	return v, path
}

func httpRecord(id string) Record {
	return Record{ID: id, Kind: KindHTTP, Hosts: []string{"api.example.test"}, Header: "X-Api-Key", Format: "raw"}
}

func TestPutStoresValueAndIndexWithoutTheValue(t *testing.T) {
	store := NewMemory()
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	got, err := v.Value("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value = %q, %v", got, err)
	}
	stored, _ := store.Get("weather")
	if !bytes.Equal(stored, fakeValue) {
		t.Fatalf("store holds %q", stored)
	}
	index, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(index, fakeValue) {
		t.Fatal("the index file contains the secret value")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("index mode %v, want 0600", info.Mode().Perm())
	}
	rec, ok := v.Record("weather")
	if !ok || rec.CreatedAt.IsZero() || rec.Hosts[0] != "api.example.test" {
		t.Fatalf("Record = %+v, %v", rec, ok)
	}
}

func TestOpenReloadsTheIndex(t *testing.T) {
	store := NewMemory()
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	again, err := Open(store, path)
	if err != nil {
		t.Fatal(err)
	}
	if recs := again.Records(); len(recs) != 1 || recs[0].ID != "weather" {
		t.Fatalf("Records = %+v", recs)
	}
	got, err := again.Value("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value after reopen = %q, %v", got, err)
	}
}

func TestPutRejectsBadIDsAndValues(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	for _, id := range []string{"", "Weather", "-x", "a b", strings.Repeat("a", 65), "lmstudio", "ollama"} {
		if err := v.Put(httpRecord(id), fakeValue); err == nil {
			t.Errorf("Put id %q succeeded", id)
		}
	}
	bad := [][]byte{
		nil,
		[]byte("short"),
		[]byte("has\nnewline-value"),
		[]byte(" leading-space-value"),
		[]byte("trailing-space-value "),
		[]byte("non-ascii-värde-value"),
		bytes.Repeat([]byte("a"), 8193),
	}
	for _, value := range bad {
		if err := v.Put(httpRecord("weather"), value); err == nil {
			t.Errorf("Put value %q succeeded", value)
		}
	}
	if _, ok := v.Record("weather"); ok {
		t.Fatal("a rejected Put left a record")
	}
}

func TestDeleteRemovesValueAndRecord(t *testing.T) {
	store := NewMemory()
	v, _ := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	if err := v.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Value("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Value after delete: %v", err)
	}
	if _, err := store.Get("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("store after delete: %v", err)
	}
	if err := v.Delete("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second Delete: %v", err)
	}
}

func TestValueReadsTheStoreOnceThenCaches(t *testing.T) {
	store := &countingStore{Store: NewMemory()}
	v, path := openTemp(t, store)
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	again, _ := Open(store, path)
	for range 3 {
		if _, err := again.Value("weather"); err != nil {
			t.Fatal(err)
		}
	}
	if store.gets != 1 {
		t.Fatalf("store read %d times, want 1", store.gets)
	}
}

func TestPutKeepsCreatedAtOnUpdate(t *testing.T) {
	v, _ := openTemp(t, NewMemory())
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	first, _ := v.Record("weather")
	time.Sleep(2 * time.Millisecond)
	if err := v.Put(httpRecord("weather"), []byte("second-fake-value-for-test")); err != nil {
		t.Fatal(err)
	}
	second, _ := v.Record("weather")
	if !second.CreatedAt.Equal(first.CreatedAt) || !second.UpdatedAt.After(first.UpdatedAt) {
		t.Fatalf("times: first %+v second %+v", first, second)
	}
	got, _ := v.Value("weather")
	if string(got) != "second-fake-value-for-test" {
		t.Fatalf("Value = %q", got)
	}
}

func TestAnEmptyIndexPathKeepsEverythingInMemory(t *testing.T) {
	v, err := Open(NewMemory(), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := v.Put(httpRecord("weather"), fakeValue); err != nil {
		t.Fatal(err)
	}
	if got, err := v.Value("weather"); err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Value = %q, %v", got, err)
	}
	if err := v.Delete("weather"); err != nil {
		t.Fatal(err)
	}
}

type countingStore struct {
	Store
	gets int
}

func (c *countingStore) Get(id string) ([]byte, error) {
	c.gets++
	return c.Store.Get(id)
}
```

`keyd/internal/vault/keychain_test.go`:
```go
package vault

import (
	"bytes"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeSecurity mimics the /usr/bin/security calls Keychain makes, keeping items as files. Like the
// real tool, security -i runs the first 4,095 characters of a line as one command and the rest as
// another, names an unknown command in its error, and exits with the last command's status.
// FAKE_FAIL=add makes every add fail after printing what it was given.
const fakeSecurity = `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DIR/argv.log"
store="$FAKE_DIR/store"
mkdir -p "$store"
run() {
  cmd=$1
  shift
  svc= acct= pw=
  while [ $# -gt 0 ]; do
    case "$1" in
      -s) svc=$2; shift 2 ;;
      -a) acct=$2; shift 2 ;;
      -w) if [ $# -ge 2 ]; then pw=$2; shift 2; else shift; fi ;;
      -l) shift 2 ;;
      *) shift ;;
    esac
  done
  item="$store/$svc.$acct"
  case "$cmd" in
    add-generic-password)
      if [ "$FAKE_FAIL" = add ]; then echo "add-generic-password: cannot store $pw" >&2; return 1; fi
      printf '%s' "$pw" > "$item" ;;
    find-generic-password) [ -f "$item" ] || return 44; cat "$item"; echo ;;
    delete-generic-password) [ -f "$item" ] || return 44; rm "$item" ;;
    *) echo "security: unknown command \"$cmd\"" >&2; return 1 ;;
  esac
}
if [ "$1" = "-i" ]; then
  fold -w 4095 | {
    status=0
    while IFS= read -r piece; do
      run $piece
      status=$?
    done
    exit $status
  }
  exit $?
fi
run "$@"
`

func fakeKeychain(t *testing.T) (*Keychain, string) {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "security")
	if err := os.WriteFile(bin, []byte(fakeSecurity), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_DIR", dir)
	return &Keychain{Service: "localdot-keyd-test", Path: bin}, dir
}

// longValue is a fake printable value of n bytes.
func longValue(n int) []byte {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.+/="
	rng := rand.New(rand.NewPCG(7, uint64(n)))
	out := make([]byte, n)
	for i := range out {
		out[i] = chars[rng.IntN(len(chars))]
	}
	return out
}

// carries reports whether text holds any 8 bytes of value or any 16 characters of its hex.
func carries(text string, value []byte) bool {
	h := hex.EncodeToString(value)
	for i := 0; i+8 <= len(value); i++ {
		if strings.Contains(text, string(value[i:i+8])) {
			return true
		}
	}
	for i := 0; i+16 <= len(h); i++ {
		if strings.Contains(text, h[i:i+16]) {
			return true
		}
	}
	return false
}

func TestKeychainRoundTripThroughTheSecurityTool(t *testing.T) {
	k, dir := fakeKeychain(t)
	if err := k.Put("weather", fakeValue); err != nil {
		t.Fatal(err)
	}
	got, err := k.Get("weather")
	if err != nil || !bytes.Equal(got, fakeValue) {
		t.Fatalf("Get = %q, %v", got, err)
	}
	if err := k.Delete("weather"); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	if err := k.Delete("weather"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete twice: %v", err)
	}
	argv, err := os.ReadFile(filepath.Join(dir, "argv.log"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(argv, fakeValue) || bytes.Contains(argv, []byte(hex.EncodeToString(fakeValue))) {
		t.Fatalf("the secret reached the command line: %s", argv)
	}
}

func TestKeychainKeepsLongValuesWhole(t *testing.T) {
	k, dir := fakeKeychain(t)
	for _, n := range []int{3000, maxValueLen} {
		value := longValue(n)
		if err := k.Put("weather", value); err != nil {
			t.Fatalf("Put of %d bytes: %v", n, err)
		}
		if got, err := k.Get("weather"); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", n, len(got), err)
		}
	}
	if err := k.Put("weather", fakeValue); err != nil {
		t.Fatal(err)
	}
	items, _ := os.ReadDir(filepath.Join(dir, "store"))
	if len(items) != 2 {
		t.Fatalf("%d items after a short value replaced a long one, want the item and one chunk", len(items))
	}
	argv, _ := os.ReadFile(filepath.Join(dir, "argv.log"))
	if carries(string(argv), longValue(maxValueLen)) {
		t.Fatalf("the secret reached the command line: %s", argv)
	}
}

func TestKeychainErrorsNeverCarryTheValue(t *testing.T) {
	k, dir := fakeKeychain(t)
	value := longValue(maxValueLen)
	t.Setenv("FAKE_FAIL", "add")
	if err := k.Put("weather", value); err == nil || carries(err.Error(), value) {
		t.Fatalf("Put through a failing tool: %v", err)
	}
	t.Setenv("FAKE_FAIL", "")
	if err := k.Put("weather", value); err != nil {
		t.Fatal(err)
	}
	// A chunk from another write: what a crash between two chunk writes leaves.
	chunk := filepath.Join(dir, "store", "localdot-keyd-test.weather.1")
	data, err := os.ReadFile(chunk)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(chunk, append([]byte(strings.Repeat("0", 16)), data[16:]...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get("weather"); err == nil || carries(err.Error(), value) {
		t.Fatalf("Get of a torn value: %v", err)
	}
}

func TestKeychainReportsToolFailures(t *testing.T) {
	k := &Keychain{Service: "localdot-keyd-test", Path: filepath.Join(t.TempDir(), "missing")}
	if err := k.Put("weather", fakeValue); err == nil {
		t.Fatal("Put through a missing tool succeeded")
	}
	if _, err := k.Get("weather"); err == nil || errors.Is(err, ErrNotFound) {
		t.Fatalf("Get through a missing tool: %v", err)
	}
}

// Opt-in: writes and deletes fake items in the login keychain, the longest value included.
func TestKeychainAgainstTheLoginKeychain(t *testing.T) {
	if runtime.GOOS != "darwin" || os.Getenv("KEYD_KEYCHAIN_TEST") != "1" {
		t.Skip("set KEYD_KEYCHAIN_TEST=1 on macOS to use the login keychain")
	}
	k := NewKeychain("localdot-keyd-test")
	id := fmt.Sprintf("probe-%d", time.Now().UnixNano())
	t.Cleanup(func() { _ = k.Delete(id) })
	for _, value := range [][]byte{fakeValue, longValue(maxValueLen), []byte("second-fake-value-for-test")} {
		if err := k.Put(id, value); err != nil {
			t.Fatalf("Put of %d bytes: %v", len(value), err)
		}
		if got, err := k.Get(id); err != nil || !bytes.Equal(got, value) {
			t.Fatalf("Get after %d bytes: %d bytes back, %v", len(value), len(got), err)
		}
	}
	if err := k.Delete(id); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Get(id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete: %v", err)
	}
	if exec.Command(k.Path, "find-generic-password", "-s", k.Service).Run() == nil {
		t.Fatal("an item of the test service outlived Delete")
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/vault/`
Expected: FAIL — `[build failed]`, starting `internal/vault/vault_test.go:15:35: undefined: Store`.

- [ ] **Step 3: Implement the stores and the vault**

`keyd/internal/vault/store.go`:
```go
package vault

import (
	"errors"
	"slices"
	"sync"
)

// ErrNotFound means the store has no value for the id.
var ErrNotFound = errors.New("vault: secret not found")

// Store keeps secret values by id; the Keychain in production, Memory in tests.
type Store interface {
	Put(id string, value []byte) error
	Get(id string) ([]byte, error)
	Delete(id string) error
}

// Memory is a Store that lives only as long as the process.
type Memory struct {
	mu     sync.Mutex
	values map[string][]byte
}

func NewMemory() *Memory {
	return &Memory{values: map[string][]byte{}}
}

func (m *Memory) Put(id string, value []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.values[id] = slices.Clone(value)
	return nil
}

func (m *Memory) Get(id string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[id]
	if !ok {
		return nil, ErrNotFound
	}
	return slices.Clone(v), nil
}

func (m *Memory) Delete(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.values[id]; !ok {
		return ErrNotFound
	}
	delete(m.values, id)
	return nil
}
```

`keyd/internal/vault/keychain.go`:
```go
package vault

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
)

// errSecItemNotFound is the exit status /usr/bin/security uses for a missing item.
const errSecItemNotFound = 44

// security -i runs the first 4,095 characters of a line as one command and the rest as another,
// so a value is stored in chunks that fit one line: 1,536 bytes are 3,072 hex characters, after
// at most about 230 of command.
const (
	chunkBytes = 1536
	maxChunks  = (maxValueLen + chunkBytes - 1) / chunkBytes
)

// Keychain stores values as generic passwords in the login keychain through /usr/bin/security.
// Values travel hex-encoded on the tool's stdin, never on its command line. A value is split into
// chunk items <id>.0, <id>.1, …; the item <id> names their count and the write that made them, so
// a read never mixes two writes. The tool's output never leaves keyd: it can echo a value, so an
// error names only the operation, the item and the exit status.
type Keychain struct {
	Service string
	Path    string
}

func NewKeychain(service string) *Keychain {
	return &Keychain{Service: service, Path: "/usr/bin/security"}
}

// Put writes the chunks, then the item that names them, then reads the value back: a write the
// tool split, cut short or refused is an error, never a stored fragment.
func (k *Keychain) Put(id string, value []byte) error {
	gen, err := newWriteID()
	if err != nil {
		return err
	}
	n := (len(value) + chunkBytes - 1) / chunkBytes
	for i := range n {
		part := value[i*chunkBytes : min(len(value), (i+1)*chunkBytes)]
		if err := k.add(chunkAccount(id, i), gen+":"+hex.EncodeToString(part)); err != nil {
			return err
		}
	}
	if err := k.add(id, fmt.Sprintf("keyd:%s:%d", gen, n)); err != nil {
		return err
	}
	if got, err := k.Get(id); err != nil || !bytes.Equal(got, value) {
		return fmt.Errorf("keychain: store %s: the value did not read back intact", id)
	}
	for i := n; i < maxChunks; i++ {
		k.remove(chunkAccount(id, i))
	}
	return nil
}

func (k *Keychain) Get(id string) ([]byte, error) {
	head, err := k.find(id)
	if err != nil {
		return nil, err
	}
	gen, count, ok := parseHead(head)
	if !ok {
		return nil, fmt.Errorf("keychain: item %s is not keyd's", id)
	}
	value := make([]byte, 0, count*chunkBytes)
	for i := range count {
		data, err := k.find(chunkAccount(id, i))
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		g, encoded, _ := strings.Cut(data, ":")
		part, derr := hex.DecodeString(encoded)
		if err != nil || g != gen || derr != nil {
			return nil, fmt.Errorf("keychain: item %s was torn by an interrupted write; store it again", id)
		}
		value = append(value, part...)
	}
	return value, nil
}

// Delete removes the item and every chunk it may have had.
func (k *Keychain) Delete(id string) error {
	err := k.remove(id)
	for i := range maxChunks {
		if cerr := k.remove(chunkAccount(id, i)); cerr != nil && !errors.Is(cerr, ErrNotFound) && err == nil {
			err = cerr
		}
	}
	return err
}

// add writes one item in a security -i session of one line, so the exit status is that line's.
func (k *Keychain) add(account, data string) error {
	line := fmt.Sprintf("add-generic-password -U -s %s -a %s -l localDot-%s -w %s\n", k.Service, account, account, data)
	return k.run("store", account, strings.NewReader(line), nil, "-i")
}

func (k *Keychain) find(account string) (string, error) {
	var out bytes.Buffer
	if err := k.run("read", account, nil, &out, "find-generic-password", "-s", k.Service, "-a", account, "-w"); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func (k *Keychain) remove(account string) error {
	return k.run("delete", account, nil, nil, "delete-generic-password", "-s", k.Service, "-a", account)
}

// run reports only how the tool ended; what it printed is dropped.
func (k *Keychain) run(op, account string, stdin io.Reader, stdout io.Writer, args ...string) error {
	cmd := exec.Command(k.Path, args...)
	cmd.Stdin, cmd.Stdout = stdin, stdout
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return nil
	case errors.As(err, &exit) && exit.ExitCode() == errSecItemNotFound:
		return ErrNotFound
	case errors.As(err, &exit):
		return fmt.Errorf("keychain: %s %s: security exited with status %d", op, account, exit.ExitCode())
	}
	return fmt.Errorf("keychain: %s %s: %w", op, account, err)
}

func chunkAccount(id string, i int) string {
	return id + "." + strconv.Itoa(i)
}

func parseHead(head string) (gen string, count int, ok bool) {
	parts := strings.Split(head, ":")
	if len(parts) != 3 || parts[0] != "keyd" {
		return "", 0, false
	}
	count, err := strconv.Atoi(parts[2])
	if err != nil || count < 1 || count > maxChunks {
		return "", 0, false
	}
	return parts[1], count, true
}

func newWriteID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
```

`keyd/internal/vault/vault.go`:
```go
// Package vault keeps keyd's secrets: values in a Store, metadata in an index file that never
// holds a value.
package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"sync"
	"time"
)

type Kind string

const (
	KindLLM  Kind = "llm"
	KindHTTP Kind = "http"
)

// Record describes a secret and where it may be used. keys.FromRecord validates the binding
// fields; the vault checks only the id, the kind and the value.
type Record struct {
	ID        string    `json:"id"`
	Kind      Kind      `json:"kind"`
	Provider  string    `json:"provider,omitempty"`
	BaseURL   string    `json:"baseURL,omitempty"`
	Hosts     []string  `json:"hosts,omitempty"`
	Header    string    `json:"header,omitempty"`
	Format    string    `json:"format,omitempty"`
	Methods   []string  `json:"methods,omitempty"`
	Paths     []string  `json:"paths,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

const (
	minValueLen = 8
	maxValueLen = 8192
)

var (
	idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
	// The LLM gateway's local routes share the gateway's namespace with secret ids.
	reservedIDs = []string{"lmstudio", "ollama"}
)

// ValidID reports whether id can name a secret.
func ValidID(id string) bool {
	return idPattern.MatchString(id) && !slices.Contains(reservedIDs, id)
}

// ValidValue rejects values that could break a header or match too much when scrubbed.
func ValidValue(value []byte) error {
	if len(value) < minValueLen || len(value) > maxValueLen {
		return fmt.Errorf("secret value must be %d-%d bytes", minValueLen, maxValueLen)
	}
	for _, b := range value {
		if b < 0x20 || b > 0x7e {
			return errors.New("secret value must be printable ASCII")
		}
	}
	if value[0] == ' ' || value[len(value)-1] == ' ' {
		return errors.New("secret value must not start or end with a space")
	}
	return nil
}

type indexFile struct {
	V       int      `json:"v"`
	Secrets []Record `json:"secrets"`
}

// Vault is safe for concurrent use.
type Vault struct {
	store   Store
	path    string
	now     func() time.Time
	mu      sync.Mutex
	records map[string]Record
	cache   map[string][]byte
}

// Open loads the index at path; a missing file is an empty vault. An empty path keeps the index
// in memory only, for a vault whose values are in memory too.
func Open(store Store, path string) (*Vault, error) {
	v := &Vault{store: store, path: path, now: time.Now, records: map[string]Record{}, cache: map[string][]byte{}}
	if path == "" {
		return v, nil
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return nil, err
	}
	var idx indexFile
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("vault index %s: %w", path, err)
	}
	for _, r := range idx.Secrets {
		v.records[r.ID] = r
	}
	return v, nil
}

func (v *Vault) Put(rec Record, value []byte) error {
	if !ValidID(rec.ID) {
		return fmt.Errorf("secret id %q: want 1-64 of a-z 0-9 _ - starting with a letter or digit, not a reserved name", rec.ID)
	}
	if rec.Kind != KindLLM && rec.Kind != KindHTTP {
		return fmt.Errorf("secret kind %q: want llm or http", rec.Kind)
	}
	if err := ValidValue(value); err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now().UTC()
	rec.CreatedAt, rec.UpdatedAt = now, now
	if old, ok := v.records[rec.ID]; ok {
		rec.CreatedAt = old.CreatedAt
	}
	if err := v.store.Put(rec.ID, value); err != nil {
		return err
	}
	v.records[rec.ID] = rec
	v.cache[rec.ID] = slices.Clone(value)
	return v.saveLocked()
}

func (v *Vault) Delete(id string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id]; !ok {
		return ErrNotFound
	}
	if err := v.store.Delete(id); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	delete(v.records, id)
	delete(v.cache, id)
	return v.saveLocked()
}

func (v *Vault) Record(id string) (Record, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()
	r, ok := v.records[id]
	return r, ok
}

func (v *Vault) Records() []Record {
	v.mu.Lock()
	defer v.mu.Unlock()
	out := make([]Record, 0, len(v.records))
	for _, r := range v.records {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Value returns the secret, reading the store only on the first use.
func (v *Vault) Value(id string) ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if _, ok := v.records[id]; !ok {
		return nil, ErrNotFound
	}
	if cached, ok := v.cache[id]; ok {
		return slices.Clone(cached), nil
	}
	value, err := v.store.Get(id)
	if err != nil {
		return nil, err
	}
	v.cache[id] = slices.Clone(value)
	return value, nil
}

func (v *Vault) saveLocked() error {
	if v.path == "" {
		return nil
	}
	idx := indexFile{V: 1, Secrets: make([]Record, 0, len(v.records))}
	for _, r := range v.records {
		idx.Secrets = append(idx.Secrets, r)
	}
	sort.Slice(idx.Secrets, func(i, j int) bool { return idx.Secrets[i].ID < idx.Secrets[j].ID })
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(v.path, data)
}

func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".secrets-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
```

- [ ] **Step 4: Run the tests, then the opt-in Keychain test once**

Run: `go test ./internal/vault/`
Expected: `ok` (12 tests, `TestKeychainAgainstTheLoginKeychain` skipped).
Run: `KEYD_KEYCHAIN_TEST=1 go test -run LoginKeychain -v ./internal/vault/`
Expected: `--- PASS: TestKeychainAgainstTheLoginKeychain` (it stores 26 bytes, then 8,192, then 26
again, reading each back, and deletes the item and its chunks). If macOS asks to allow `security` to use
the login keychain, choose Always Allow. Then
`security find-generic-password -s localdot-keyd-test; echo $?` prints `44`: nothing was left behind.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/vault
git commit -m "feat(keyd): vault with Keychain and in-memory stores"
```

---
