package vault

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Preserve the existing versioned item format while moving its ACL owner to signed keyd.
const (
	chunkBytes      = 1536
	maxChunks       = (maxValueLen + chunkBytes - 1) / chunkBytes
	keychainTimeout = 5 * time.Second
)

// Keychain stores generic passwords through a bounded child of the same signed keyd executable.
// Security.framework gives keyd the explicit trusted-app ACL. Values travel on stdin, never argv.
// A value is split into
// chunk items <id>.0, <id>.1, …; the item <id> names their count, the write that made them and the
// binding the value was stored for, so a read never mixes two writes or serves another binding.
// The tool's output never leaves keyd: it can echo a value, so an error names only the operation,
// the item and the exit status.
type Keychain struct {
	Service string
	Path    string
	// One deadline covers every chunk, verification and best-effort cleanup.
	// Tests shorten it; production always uses keychainTimeout.
	timeout time.Duration
	// Package-local subprocess injection for offline fixtures; never populated by NewKeychain.
	configureCommand func(*exec.Cmd)
}

func NewKeychain(service string) *Keychain {
	// An unavailable executable produces a closed failure, never a PATH-based fallback.
	path, _ := os.Executable()
	return &Keychain{Service: service, Path: path}
}

// Check verifies the native helper and its parent identity without opening a keychain.
func (k *Keychain) Check() error {
	ctx, cancel := k.deadline()
	defer cancel()
	return k.run(ctx, "check", "status", nil, nil)
}

// Put writes the chunks, then the item that names them, then reads the value back: a write the
// helper cut short or refused is an error, never a stored fragment. Only validated item IDs
// and values Delete can remove whole are accepted.
func (k *Keychain) Put(id string, value []byte, binding string) error {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("keychain: %q is not a secret id", id)
	}
	if len(value) == 0 || len(value) > maxValueLen {
		return fmt.Errorf("keychain: store %s: want 1-%d bytes", id, maxValueLen)
	}
	if !bindingPattern.MatchString(binding) {
		return fmt.Errorf("keychain: store %s: invalid binding (%w)", id, errUnchanged)
	}
	gen, err := newWriteID()
	if err != nil {
		return err
	}
	ctx, cancel := k.deadline()
	defer cancel()
	n := (len(value) + chunkBytes - 1) / chunkBytes
	for i := range n {
		part := value[i*chunkBytes : min(len(value), (i+1)*chunkBytes)]
		if err := k.add(ctx, chunkAccount(id, i), gen+":"+hex.EncodeToString(part)); err != nil {
			return k.abandon(ctx, id, i > 0, err)
		}
	}
	if err := k.add(ctx, id, itemHead(gen, n, binding)); err != nil {
		return k.abandon(ctx, id, true, err)
	}
	if got, err := k.get(ctx, id, binding); err != nil || !bytes.Equal(got, value) {
		return k.abandon(ctx, id, true, fmt.Errorf("keychain: store %s: the value did not read back intact", id))
	}
	// The value read back whole, and Get never reads past the count the item names, so an old chunk
	// that stays is a fragment of the old value, not a failure of this one.
	for i := n; i < maxChunks; i++ {
		if err := k.remove(ctx, chunkAccount(id, i)); err != nil && !errors.Is(err, ErrNotFound) {
			log.Printf("keyd: storing secret %s left an old chunk behind: %v", id, err)
		}
	}
	return nil
}

// abandon ends a failed Put. Once the Put has written an item the old value no longer reads back,
// so the whole item goes, best effort. Only a known pre-effect refusal may claim the previous
// value is unchanged; a failed or timed-out helper may already have written its chunk.
func (k *Keychain) abandon(ctx context.Context, id string, wrote bool, err error) error {
	if !wrote && ctx.Err() == nil && errors.Is(err, errUnchanged) {
		return fmt.Errorf("%w (%w)", err, errUnchanged)
	}
	_ = k.delete(ctx, id)
	// Strip errUnchanged if an earlier chunk did change, and keep only a static
	// failure. The Vault then restores the previous value or fails closed.
	return fmt.Errorf("keychain: store %s: write did not complete", id)
}

func (k *Keychain) Get(id, binding string) ([]byte, error) {
	if !idPattern.MatchString(id) || !bindingPattern.MatchString(binding) {
		return nil, errors.New("keychain: invalid secret id or binding")
	}
	ctx, cancel := k.deadline()
	defer cancel()
	return k.get(ctx, id, binding)
}

// get refuses a value stored for another binding before reading any of it. An item written before
// keyd stored bindings takes the binding of its first read, as its ACL does on first access; from
// then on a keyd build that predates bindings cannot parse it.
func (k *Keychain) get(ctx context.Context, id, binding string) ([]byte, error) {
	head, err := k.find(ctx, id)
	if err != nil {
		return nil, err
	}
	gen, count, bound, ok := parseHead(head)
	if !ok {
		return nil, fmt.Errorf("keychain: item %s is not keyd's", id)
	}
	if bound != "" && bound != binding {
		return nil, fmt.Errorf("keychain: item %s: %w", id, errRebound)
	}
	value := make([]byte, 0, count*chunkBytes)
	for i := range count {
		data, err := k.find(ctx, chunkAccount(id, i))
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
	if bound == "" {
		if err := k.add(ctx, id, itemHead(gen, count, binding)); err != nil {
			log.Printf("keyd: secret %s is still stored without its binding: %v", id, err)
		}
	}
	return value, nil
}

// Delete removes the item and every chunk it may have had. A chunk it cannot remove is an error even
// when the item is already gone, so a retry never reports success over a fragment left behind.
func (k *Keychain) Delete(id string) error {
	if !idPattern.MatchString(id) {
		return errors.New("keychain: invalid secret id")
	}
	ctx, cancel := k.deadline()
	defer cancel()
	return k.delete(ctx, id)
}

func (k *Keychain) delete(ctx context.Context, id string) error {
	err := k.remove(ctx, id)
	for i := range maxChunks {
		cerr := k.remove(ctx, chunkAccount(id, i))
		if cerr != nil && !errors.Is(cerr, ErrNotFound) && (err == nil || errors.Is(err, ErrNotFound)) {
			err = cerr
		}
	}
	return err
}

// The child authenticates its signed parent before any Keychain access.
func (k *Keychain) add(ctx context.Context, account, data string) error {
	return k.run(ctx, "store", account, strings.NewReader(data), nil)
}

func (k *Keychain) find(ctx context.Context, account string) (string, error) {
	var out keychainOutput
	if err := k.run(ctx, "read", account, nil, &out); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func (k *Keychain) remove(ctx context.Context, account string) error {
	return k.run(ctx, "delete", account, nil, nil)
}

// run reports only how the tool ended; what it printed is dropped.
func (k *Keychain) run(ctx context.Context, op, account string, stdin io.Reader, stdout io.Writer) error {
	if (k.Service != "localdot-keyd" && k.Service != "localdot-keyd-test") || !accountPattern.MatchString(account) {
		return fmt.Errorf("keychain: invalid item (%w)", errUnchanged)
	}
	cmd := exec.CommandContext(ctx, k.Path, "keychain-item", op, k.Service, account)
	// Do not pass provider credentials, loader hooks, HOME overrides or other ambient secrets.
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=en_US.UTF-8"}
	cmd.Dir = "/"
	if k.configureCommand != nil {
		k.configureCommand(cmd)
	}
	// Do not wait indefinitely for an inherited stdout/stdin pipe after the
	// process has exited or was killed at its deadline.
	cmd.WaitDelay = 100 * time.Millisecond
	cmd.Stdin, cmd.Stdout = stdin, stdout
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return fmt.Errorf("keychain: %s %s: helper timed out", op, account)
	case err == nil:
		return nil
	case errors.As(err, &exit) && exit.ExitCode() == helperNotFound && op != "store":
		return ErrNotFound
	case errors.As(err, &exit) && exit.ExitCode() == helperUnchanged:
		return fmt.Errorf("keychain: %s %s: helper refused before changing the value (%w)", op, account, errUnchanged)
	case errors.As(err, &exit):
		return fmt.Errorf("keychain: %s %s: helper exited with status %d", op, account, exit.ExitCode())
	}
	if cmd.Process == nil {
		return fmt.Errorf("keychain: %s %s: helper could not start (%w)", op, account, errUnchanged)
	}
	return fmt.Errorf("keychain: %s %s: helper failed", op, account)
}

func (k *Keychain) deadline() (context.Context, context.CancelFunc) {
	limit := k.timeout
	if limit <= 0 {
		limit = keychainTimeout
	}
	return context.WithTimeout(context.Background(), limit)
}

// A single item is at most one hex chunk plus its generation marker. Bound
// stdout independently of time, and never include it in an error.
type keychainOutput struct{ data bytes.Buffer }

func (out *keychainOutput) String() string { return out.data.String() }

func (out *keychainOutput) Write(p []byte) (int, error) {
	if out.data.Len()+len(p) > 2*chunkBytes+128 {
		return 0, errors.New("keychain output exceeded its limit")
	}
	return out.data.Write(p)
}

func chunkAccount(id string, i int) string {
	return id + "." + strconv.Itoa(i)
}

var bindingPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func itemHead(gen string, count int, binding string) string {
	return fmt.Sprintf("keyd:%s:%d:%s", gen, count, binding)
}

// parseHead reads an item head; binding is empty for a head written before bindings were stored.
func parseHead(head string) (gen string, count int, binding string, ok bool) {
	parts := strings.Split(head, ":")
	if (len(parts) != 3 && len(parts) != 4) || parts[0] != "keyd" {
		return "", 0, "", false
	}
	count, err := strconv.Atoi(parts[2])
	if err != nil || count < 1 || count > maxChunks {
		return "", 0, "", false
	}
	if len(parts) == 4 {
		if !bindingPattern.MatchString(parts[3]) {
			return "", 0, "", false
		}
		binding = parts[3]
	}
	return parts[1], count, binding, true
}

func newWriteID() (string, error) {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
