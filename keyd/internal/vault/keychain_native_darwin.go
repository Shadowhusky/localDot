//go:build darwin && cgo

package vault

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Security -framework CoreFoundation
#include <Security/Security.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "keychain_items_darwin.h"

#define KEYD_SIGNED_BY \
  " and anchor apple generic and " \
  "certificate 1[field.1.2.840.113635.100.6.2.6] exists and " \
  "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and " \
  "certificate leaf[subject.OU] = \"87FD3FSZBG\""

// keyd is signed with this as its designated requirement, and its Info.plist (internal/keydinfo)
// carries the generation. Every keyd before generation 2 could start a program as keyd's child, so
// none of them meets it.
static const char *keyd_requirement =
  "identifier \"dev.localdot.keyd\"" KEYD_SIGNED_BY " and info [KeydGeneration] >= \"2\"";

static const char *keyd_designated(void) { return keyd_requirement; }

// What every earlier keyd's items trust. keyd meets it too, which is how it adopts them
// (keyd_adopt); nothing else accepts it.
static const char *keyd_earlier_requirement = "identifier \"dev.localdot.keyd\"" KEYD_SIGNED_BY;

static OSStatus keyd_check_code(SecCodeRef code, SecRequirementRef requirement) {
  // Per-item identity checks stay offline. Release notarization/revocation acceptance is a
  // separate installer gate, not a network request on every secret access.
  OSStatus status = SecCodeCheckValidity(code, kSecCSStrictValidate | kSecCSNoNetworkAccess, requirement);
  SecStaticCodeRef file = NULL;
  CFDictionaryRef info = NULL;
  if (status == errSecSuccess) status = SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &file);
  if (status == errSecSuccess) status = SecCodeCopySigningInformation(file, kSecCSSigningInformation, &info);
  if (status == errSecSuccess) status = keyd_signing_info(info);
  if (info) CFRelease(info);
  if (file) CFRelease(file);
  return status;
}

static OSStatus keyd_check_self(SecRequirementRef requirement) {
  SecCodeRef self = NULL;
  OSStatus status = SecCodeCopySelf(kSecCSDefaultFlags, &self);
  if (status == errSecSuccess) status = keyd_check_code(self, requirement);
  if (self) CFRelease(self);
  return status;
}

static OSStatus keyd_check_process(pid_t parentPID, SecRequirementRef requirement) {
  SecCodeRef parent = NULL;
  CFDictionaryRef attributes = NULL;
  CFNumberRef pid = CFNumberCreate(NULL, kCFNumberIntType, &parentPID);
  OSStatus status = errSecAllocate;
  if (pid) {
    const void *keys[] = { kSecGuestAttributePid };
    const void *values[] = { pid };
    attributes = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  }
  if (attributes) status = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &parent);
  if (status == errSecSuccess) status = keyd_check_code(parent, requirement);
  if (attributes) CFRelease(attributes);
  if (pid) CFRelease(pid);
  if (parent) CFRelease(parent);
  return status;
}

static const keyd_identity_checks keyd_process_checks = { getppid, keyd_check_self, keyd_check_process, keyd_check_mode };

// Identity checks are deliberately before even selecting the keychain. No PID argument,
// development bypass, generic security tool or unsigned fallback exists.
static OSStatus keyd_authorized(int checkOnly, pid_t *parent) {
  CFStringRef text = CFStringCreateWithCString(NULL, keyd_requirement, kCFStringEncodingUTF8);
  SecRequirementRef requirement = NULL;
  OSStatus status = text ? SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement) : errSecAllocate;
  if (status == errSecSuccess) status = keyd_identity_check(&keyd_process_checks, requirement, checkOnly, parent);
  if (requirement) CFRelease(requirement);
  if (text) CFRelease(text);
  return status;
}

// keyd's service always lives in the default keychain. The test service may name a keychain the
// test made; that never reaches keyd's own items.
static OSStatus keyd_keychain(const char *service, SecKeychainRef *keychain) {
  const char *test = getenv("KEYD_TEST_KEYCHAIN");
  if (strcmp(service, "localdot-keyd-test") == 0 && test && test[0] == '/') return SecKeychainOpen(test, keychain);
  return SecKeychainCopyDefault(keychain);
}

static OSStatus keyd_operate(const char *operation, const keyd_items *k, const keyd_session *parent,
                             const char *account, const void *data, unsigned int length,
                             void **output, unsigned int *outputLength, unsigned int *moved, unsigned int *failed,
                             int *mayHaveChanged) {
  if (strcmp(operation, "claim") == 0) return keyd_claim(k, parent, keyd_started, mayHaveChanged);
  OSStatus status = keyd_check_session(k, parent);
  if (status != errSecSuccess) return status;
  if (strcmp(operation, "adopt") == 0) return keyd_adopt(k, moved, failed, mayHaveChanged);
  UInt32 size = 0;
  if (strcmp(operation, "list") == 0) {
    status = keyd_list(k, output, &size);
    *outputLength = size;
    return status;
  }
  if (strcmp(operation, "store") == 0) return keyd_store(k, k->service, account, data, length, mayHaveChanged);
  if (strcmp(operation, "delete") == 0) return keyd_delete(k, k->service, account, mayHaveChanged);
  if (strcmp(operation, "read") != 0) return errSecParam;
  status = keyd_read(k, k->service, account, output, &size);
  *outputLength = size;
  return status;
}

static OSStatus keyd_item(const char *operation, const char *service, const char *account,
                         const void *data, unsigned int length, const unsigned char *secret, unsigned int secretLength,
                         void **output, unsigned int *outputLength, unsigned int *moved, unsigned int *failed,
                         int *mayHaveChanged) {
  int checkOnly = strcmp(operation, "check") == 0;
  pid_t parentPID = 0;
  OSStatus status = keyd_authorized(checkOnly, &parentPID);
  if (status != errSecSuccess) return status;
  // The secret shows the daemon meant to run this helper. `check` opens no keychain, so it needs
  // only the channel; every other operation needs the daemon's claim too.
  if (!secret || secretLength != KEYD_SESSION_SECRET) return errSecAuthFailed;
  if (checkOnly) return errSecSuccess;
  keyd_session parent = { .pid = parentPID };
  if (!keyd_started(parentPID, &parent.sec, &parent.usec)) return errSecAuthFailed;
  keyd_session_digest(secret, parent.digest);
  // A locked keychain must fail visibly in the caller, never pop a hidden prompt. Nothing here
  // changes an item's access list in place, which only a Keychain prompt can authorize.
  status = SecKeychainSetUserInteractionAllowed(false);
  keyd_items k = { NULL, service, keyd_requirement, keyd_earlier_requirement, NULL, NULL };
  SecTrustedApplicationRef self = NULL;
  CFArrayRef trusted = NULL;
  if (status == errSecSuccess) status = keyd_keychain(service, &k.keychain);
  if (status == errSecSuccess) status = SecTrustedApplicationCreateFromPath(NULL, &self);
  if (status == errSecSuccess) {
    const void *apps[] = { self };
    trusted = CFArrayCreate(NULL, apps, 1, &kCFTypeArrayCallBacks);
    if (!trusted) status = errSecAllocate;
  }
  if (status == errSecSuccess) status = SecAccessCreate(CFSTR("localDot secret — keyd only"), trusted, &k.access);
  if (status == errSecSuccess)
    status = keyd_operate(operation, &k, &parent, account, data, length, output, outputLength, moved, failed,
                          mayHaveChanged);
  if (k.access) CFRelease(k.access);
  if (trusted) CFRelease(trusted);
  if (self) CFRelease(self);
  if (k.keychain) CFRelease(k.keychain);
  return status;
}
*/
import "C"

import "unsafe"

func nativeKeychainItem(operation, service, account string, data, secret []byte) ([]byte, adoption, int) {
	op, svc, acct := C.CString(operation), C.CString(service), C.CString(account)
	defer C.free(unsafe.Pointer(op))
	defer C.free(unsafe.Pointer(svc))
	defer C.free(unsafe.Pointer(acct))
	var input, session unsafe.Pointer
	if len(data) > 0 {
		input = unsafe.Pointer(&data[0])
	}
	if len(secret) > 0 {
		session = unsafe.Pointer(&secret[0])
	}
	var output unsafe.Pointer
	var length, moved, failed C.uint
	var mayHaveChanged C.int
	status := C.keyd_item(op, svc, acct, input, C.uint(len(data)), (*C.uchar)(session), C.uint(len(secret)),
		&output, &length, &moved, &failed, &mayHaveChanged)
	limit := helperItemLimit
	if operation == "list" {
		// keyd_list allocates the list itself; it names items, and holds no secret to clear.
		defer C.free(output)
		limit = helperListLimit
	} else {
		defer C.keyd_free(output, C.UInt32(length))
	}
	if code := nativeExit(int32(status), mayHaveChanged != 0); code != 0 {
		return nil, adoption{}, code
	}
	switch {
	case int(length) > limit:
		return nil, adoption{}, 1
	case operation == "list":
		return C.GoBytes(output, C.int(length)), adoption{}, 0
	case operation != "read":
		return nil, adoption{moved: int(moved), failed: int(failed)}, 0
	case output == nil || length == 0:
		return nil, adoption{}, 1
	}
	return C.GoBytes(output, C.int(length)), adoption{}, 0
}

const (
	nativeItemNotFound = int32(C.errSecItemNotFound)
	nativeNotOurs      = int32(C.KEYD_NOT_OURS)
)

// nativeExit is the helper's status for a native result. Only a failure before any write began may
// claim the old value is whole.
func nativeExit(status int32, mayHaveChanged bool) int {
	switch {
	case status == nativeItemNotFound:
		return helperNotFound
	case status == 0:
		return 0
	case mayHaveChanged:
		return 1
	case status == nativeNotOurs:
		return helperNotOurs
	}
	return helperUnchanged
}

// Used by an unsigned test executable to check the denial path without opening any keychain.
func nativeKeychainAuthorized() bool {
	var parent C.pid_t
	return C.keyd_authorized(1, &parent) == C.errSecSuccess
}

// DesignatedRequirement is what keyd must be signed with as its designated requirement.
func DesignatedRequirement() string { return C.GoString(C.keyd_designated()) }
