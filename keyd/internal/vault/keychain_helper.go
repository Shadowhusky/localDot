package vault

import (
	"errors"
	"io"
	"regexp"
	"strconv"
	"syscall"
)

const (
	helperNotFound  = 44
	helperUnchanged = 45
	// helperNotOurs refuses a read of an item whose access list is neither keyd's nor an earlier
	// keyd's: no keyd made it.
	helperNotOurs   = 46
	helperItemLimit = 2*chunkBytes + 128
	// sessionBytes is the size of the secret a keyd daemon makes at start and hands each helper.
	sessionBytes = 32
)

// An item operation names a secret, one of its chunks or the bindings marker. The daemon's claim
// and the whole service have names of their own that no secret can take.
var accountPattern = regexp.MustCompile(`^([a-z0-9][a-z0-9_-]{0,63}(\.[0-5])?|` + markerAccount + `)$`)

const (
	sessionAccount = "_session"
	serviceAccount = "_all"
)

func validRequest(op, service, account string) bool {
	if service != "localdot-keyd" && service != "localdot-keyd-test" {
		return false
	}
	switch op {
	case "store", "read", "delete", "check":
		return accountPattern.MatchString(account)
	case "claim":
		return account == sessionAccount
	case "adopt":
		return account == serviceAccount
	}
	return false
}

type keychainItemOperation func(operation, service, account string, data, secret []byte) ([]byte, int, int)

// RunKeychainItem is an internal child protocol, not a public vault CLI. The native operation
// authenticates this executable, its actual parent and the parent's mode before opening any
// keychain, and then the secret the parent handed over on descriptor 3 against the parent's claim:
// only the signed keyd daemon that holds the claim, running this helper on purpose, may drive it.
// A caller cannot obtain secret bytes by invoking the signed executable from an unrelated process,
// through a launcher, or from another keyd daemon.
func RunKeychainItem(args []string, in io.Reader, out io.Writer) int {
	return runKeychainItem(args, descriptor(3), in, out, nativeKeychainItem)
}

// descriptor reads an inherited descriptor without taking it over, so nothing ever closes it: run
// in a process that did not inherit one, its number belongs to something else.
type descriptor int

func (d descriptor) Read(p []byte) (int, error) {
	for {
		n, err := syscall.Read(int(d), p)
		switch {
		case errors.Is(err, syscall.EINTR):
			continue
		case err != nil:
			return 0, err
		case n == 0:
			return 0, io.EOF
		}
		return n, nil
	}
}

func runKeychainItem(args []string, session, in io.Reader, out io.Writer, operate keychainItemOperation) int {
	if len(args) != 3 || !validRequest(args[0], args[1], args[2]) {
		return helperUnchanged
	}
	data, err := io.ReadAll(io.LimitReader(in, helperItemLimit+1))
	if err != nil || len(data) > helperItemLimit || (args[0] == "store") != (len(data) > 0) {
		return helperUnchanged
	}
	defer clear(data)
	secret := readSession(session)
	defer clear(secret)
	value, moved, status := operate(args[0], args[1], args[2], data, secret)
	defer clear(value)
	switch {
	case status == helperNotFound && args[0] != "store":
		return helperNotFound
	case status == helperUnchanged || status == helperNotOurs:
		return status
	case status != 0:
		// A native failure may have changed an item. Never claim the old value survived it.
		return 1
	case args[0] == "adopt":
		if _, err := io.WriteString(out, strconv.Itoa(moved)); err != nil {
			return 1
		}
		return 0
	case args[0] != "read":
		if len(value) != 0 {
			return 1
		}
		return 0
	}
	if len(value) == 0 || len(value) > helperItemLimit {
		return 1
	}
	n, err := out.Write(value)
	if err != nil || n != len(value) {
		return 1
	}
	return 0
}

// readSession reads the parent's secret: exactly sessionBytes, then the end of the channel.
func readSession(r io.Reader) []byte {
	secret := make([]byte, sessionBytes+1)
	if n, err := io.ReadFull(r, secret); n != sessionBytes || !errors.Is(err, io.ErrUnexpectedEOF) {
		clear(secret)
		return nil
	}
	return secret[:sessionBytes]
}
