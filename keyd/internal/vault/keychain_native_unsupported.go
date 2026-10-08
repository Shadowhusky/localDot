//go:build !darwin || !cgo

package vault

// Never fall back to a general-purpose executable that would own the Keychain ACL instead.
func nativeKeychainItem(string, string, string, []byte) ([]byte, int) { return nil, helperUnchanged }
