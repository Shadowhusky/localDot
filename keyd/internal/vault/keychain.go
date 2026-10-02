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
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// errSecItemNotFound is the exit status /usr/bin/security uses for a missing item.
const errSecItemNotFound = 44

// security -i runs the first 4,095 characters of a line as one command and the rest as another,
// so a value is stored in chunks that fit one line: 1,536 bytes are 3,072 hex characters, after
// at most about 230 of command.
const (
	chunkBytes      = 1536
	maxChunks       = (maxValueLen + chunkBytes - 1) / chunkBytes
	keychainTimeout = 5 * time.Second
)

// Keychain stores values as generic passwords in the login keychain through /usr/bin/security.
// Values travel hex-encoded on the tool's stdin, never on its command line. A value is split into
// chunk items <id>.0, <id>.1, …; the item <id> names their count and the write that made them, so
// a read never mixes two writes. The tool's output never leaves keyd: it can echo a value, so an
// error names only the operation, the item and the exit status.
type Keychain struct {
	Service string
	Path    string
	// One deadline covers every chunk, verification and best-effort cleanup.
	// Tests shorten it; production always uses keychainTimeout.
	timeout time.Duration
}

func NewKeychain(service string) *Keychain {
	return &Keychain{Service: service, Path: "/usr/bin/security"}
}

// Put writes the chunks, then the item that names them, then reads the value back: a write the
// tool split, cut short or refused is an error, never a stored fragment. The id reaches the
// security -i line as text, so only a valid one is written, and only a value Delete can remove.
func (k *Keychain) Put(id string, value []byte) error {
	if !idPattern.MatchString(id) {
		return fmt.Errorf("keychain: %q is not a secret id", id)
	}
	if len(value) == 0 || len(value) > maxValueLen {
		return fmt.Errorf("keychain: store %s: want 1-%d bytes", id, maxValueLen)
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
	if err := k.add(ctx, id, fmt.Sprintf("keyd:%s:%d", gen, n)); err != nil {
		return k.abandon(ctx, id, true, err)
	}
	if got, err := k.get(ctx, id); err != nil || !bytes.Equal(got, value) {
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
// so the whole item goes, best effort. A first command that failed normally
// changed nothing, but a timed-out command may already have written its chunk.
func (k *Keychain) abandon(ctx context.Context, id string, wrote bool, err error) error {
	if !wrote && ctx.Err() == nil {
		return fmt.Errorf("%w (%w)", err, errUnchanged)
	}
	_ = k.delete(ctx, id)
	// Strip errUnchanged if an earlier chunk did change, and keep only a static
	// failure. The Vault then restores the previous value or fails closed.
	return fmt.Errorf("keychain: store %s: write did not complete", id)
}

func (k *Keychain) Get(id string) ([]byte, error) {
	ctx, cancel := k.deadline()
	defer cancel()
	return k.get(ctx, id)
}

func (k *Keychain) get(ctx context.Context, id string) ([]byte, error) {
	head, err := k.find(ctx, id)
	if err != nil {
		return nil, err
	}
	gen, count, ok := parseHead(head)
	if !ok {
		return nil, fmt.Errorf("keychain: item %s is not keyd's", id)
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
	return value, nil
}

// Delete removes the item and every chunk it may have had. A chunk it cannot remove is an error even
// when the item is already gone, so a retry never reports success over a fragment left behind.
func (k *Keychain) Delete(id string) error {
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

// add writes one item in a security -i session of one line, so the exit status is that line's.
func (k *Keychain) add(ctx context.Context, account, data string) error {
	line := fmt.Sprintf("add-generic-password -U -s %s -a %s -l localDot-%s -w %s\n", k.Service, account, account, data)
	return k.run(ctx, "store", account, strings.NewReader(line), nil, "-i")
}

func (k *Keychain) find(ctx context.Context, account string) (string, error) {
	var out keychainOutput
	if err := k.run(ctx, "read", account, nil, &out, "find-generic-password", "-s", k.Service, "-a", account, "-w"); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func (k *Keychain) remove(ctx context.Context, account string) error {
	return k.run(ctx, "delete", account, nil, nil, "delete-generic-password", "-s", k.Service, "-a", account)
}

// run reports only how the tool ended; what it printed is dropped.
func (k *Keychain) run(ctx context.Context, op, account string, stdin io.Reader, stdout io.Writer, args ...string) error {
	cmd := exec.CommandContext(ctx, k.Path, args...)
	// Do not wait indefinitely for an inherited stdout/stdin pipe after the
	// process has exited or was killed at its deadline.
	cmd.WaitDelay = 100 * time.Millisecond
	cmd.Stdin, cmd.Stdout = stdin, stdout
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return fmt.Errorf("keychain: %s %s: security timed out", op, account)
	case err == nil:
		return nil
	case errors.As(err, &exit) && exit.ExitCode() == errSecItemNotFound:
		return ErrNotFound
	case errors.As(err, &exit):
		return fmt.Errorf("keychain: %s %s: security exited with status %d", op, account, exit.ExitCode())
	}
	if cmd.Process == nil {
		return fmt.Errorf("keychain: %s %s: security could not start (%w)", op, account, errUnchanged)
	}
	return fmt.Errorf("keychain: %s %s: security failed", op, account)
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
