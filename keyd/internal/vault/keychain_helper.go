package vault

import (
	"io"
	"regexp"
)

const (
	helperNotFound  = 44
	helperUnchanged = 45
	helperItemLimit = 2*chunkBytes + 128
)

var accountPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}(\.[0-5])?$`)

type keychainItemOperation func(operation, service, account string, data []byte) ([]byte, int)

// RunKeychainItem is an internal child protocol, not a public vault CLI. The native operation
// authenticates both this executable and its actual parent before opening any keychain. A caller
// cannot obtain secret bytes by invoking the signed executable from an unrelated process.
func RunKeychainItem(args []string, in io.Reader, out io.Writer) int {
	return runKeychainItem(args, in, out, nativeKeychainItem)
}

func runKeychainItem(args []string, in io.Reader, out io.Writer, operate keychainItemOperation) int {
	if len(args) != 3 || (args[0] != "store" && args[0] != "read" && args[0] != "delete" && args[0] != "check") ||
		(args[1] != "localdot-keyd" && args[1] != "localdot-keyd-test") || !accountPattern.MatchString(args[2]) {
		return helperUnchanged
	}
	data, err := io.ReadAll(io.LimitReader(in, helperItemLimit+1))
	if err != nil || len(data) > helperItemLimit || (args[0] == "store") != (len(data) > 0) {
		return helperUnchanged
	}
	defer clear(data)
	value, status := operate(args[0], args[1], args[2], data)
	defer clear(value)
	if status != 0 {
		if status == helperNotFound && args[0] != "store" {
			return helperNotFound
		}
		if status == helperUnchanged {
			return helperUnchanged
		}
		// A native failure may have changed an item. Never claim the old value survived it.
		return 1
	}
	if args[0] != "read" {
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
