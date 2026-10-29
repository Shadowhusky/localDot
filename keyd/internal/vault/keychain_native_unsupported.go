//go:build !darwin || !cgo

package vault

// Never fall back to a general-purpose executable that would own the Keychain ACL instead.
func nativeKeychainGate(string) keychainItemOperation { return nil }

// DesignatedRequirement is empty where keyd has no Keychain helper.
func DesignatedRequirement() string { return "" }

// VerifyKeydPeer cannot tell a keyd here: it refuses every peer.
func VerifyKeydPeer(int) error { return ErrNotKeyd }
