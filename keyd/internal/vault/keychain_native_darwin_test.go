//go:build darwin && cgo

package vault

import "testing"

func TestUnsignedNativeHelperRefusesBeforeKeychainAccess(t *testing.T) {
	if nativeKeychainAuthorized() {
		t.Fatal("test runner unexpectedly passed the production parent-signature gate")
	}
	for _, op := range []string{"check", "store", "read", "delete", "claim", "adopt", "list"} {
		data, adopted, status := nativeKeychainItem(op, "localdot-keyd-test", "not-an-item", []byte("fake"), testSession)
		if status == 0 || status == helperNotFound || status == helperNotOurs || len(data) != 0 || adopted != (adoption{}) {
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
		{nativeNotOurs, false, helperNotOurs},
		{nativeNotOurs, true, 1},
	} {
		if got := nativeExit(c.status, c.changed); got != c.want {
			t.Errorf("status %d, may have changed %v: exit %d, want %d", c.status, c.changed, got, c.want)
		}
	}
}
