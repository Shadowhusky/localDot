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

func TestNativeFailuresAfterAWriteBeganNeverClaimTheValueIsWhole(t *testing.T) {
	const authFailed = -25293
	for _, c := range []struct {
		status  int32
		changed bool
		want    int
	}{
		{0, false, 0},
		{0, true, 0},
		{nativeItemNotFound, false, helperNotFound},
		{authFailed, false, helperUnchanged},
		{authFailed, true, 1},
	} {
		if got := nativeExit(c.status, c.changed); got != c.want {
			t.Errorf("status %d, may have changed %v: exit %d, want %d", c.status, c.changed, got, c.want)
		}
	}
}
