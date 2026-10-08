//go:build darwin && cgo

package vault

import "testing"

func TestUnsignedNativeHelperRefusesBeforeKeychainAccess(t *testing.T) {
	if nativeKeychainAuthorized() {
		t.Fatal("test runner unexpectedly passed the production parent-signature gate")
	}
	for _, op := range []string{"check", "store", "read", "delete"} {
		data, status := nativeKeychainItem(op, "localdot-keyd-test", "not-an-item", []byte("fake"))
		if status == 0 || status == helperNotFound || len(data) != 0 {
			t.Fatal("unsigned helper reached keychain or disclosed data")
		}
	}
}
