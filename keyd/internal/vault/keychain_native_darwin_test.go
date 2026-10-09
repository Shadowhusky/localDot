//go:build darwin && cgo

package vault

import (
	"os"
	"testing"
)

func TestUnsignedNativeHelperRefusesBeforeKeychainAccess(t *testing.T) {
	ops := []string{"check", "store", "read", "delete", "claim", "adopt", "list"}
	for _, op := range ops {
		if nativeKeychainGate(op) != nil {
			t.Fatalf("test runner unexpectedly passed the production parent-signature gate for %s", op)
		}
	}
	// An operation runs only for a parent that is still this process's parent.
	for _, parent := range []int{0, 1, os.Getpid()} {
		for _, op := range ops {
			data, adopted, status := nativeKeychainItem(parent, op, "localdot-keyd-test", "not-an-item", []byte("fake"), testSession)
			if status != helperUnchanged || len(data) != 0 || adopted != (adoption{}) {
				t.Fatalf("%s for parent %d reached keychain or disclosed data: %d", op, parent, status)
			}
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
