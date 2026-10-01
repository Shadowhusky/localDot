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
	n := (len(value) + chunkBytes - 1) / chunkBytes
	for i := range n {
		part := value[i*chunkBytes : min(len(value), (i+1)*chunkBytes)]
		if err := k.add(chunkAccount(id, i), gen+":"+hex.EncodeToString(part)); err != nil {
			return k.abandon(id, i > 0, err)
		}
	}
	if err := k.add(id, fmt.Sprintf("keyd:%s:%d", gen, n)); err != nil {
		return k.abandon(id, true, err)
	}
	if got, err := k.Get(id); err != nil || !bytes.Equal(got, value) {
		return k.abandon(id, true, fmt.Errorf("keychain: store %s: the value did not read back intact", id))
	}
	for i := n; i < maxChunks; i++ {
		if err := k.remove(chunkAccount(id, i)); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	return nil
}

// abandon ends a failed Put. Once the Put has written an item the old value no longer reads back,
// so the whole item goes, best effort: no fragment of either value stays behind.
func (k *Keychain) abandon(id string, wrote bool, err error) error {
	if wrote {
		_ = k.Delete(id)
	}
	return err
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

// Delete removes the item and every chunk it may have had. A chunk it cannot remove is an error even
// when the item is already gone, so a retry never reports success over a fragment left behind.
func (k *Keychain) Delete(id string) error {
	err := k.remove(id)
	for i := range maxChunks {
		cerr := k.remove(chunkAccount(id, i))
		if cerr != nil && !errors.Is(cerr, ErrNotFound) && (err == nil || errors.Is(err, ErrNotFound)) {
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
