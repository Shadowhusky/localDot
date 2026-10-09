//go:build !darwin || !cgo

package vault

// Never fall back to a general-purpose executable that would own the Keychain ACL instead.
func nativeKeychainItem(string, string, string, []byte, []byte) ([]byte, adoption, int) {
	return nil, adoption{}, helperUnchanged
}

// DesignatedRequirement is empty where keyd has no Keychain helper.
func DesignatedRequirement() string { return "" }
