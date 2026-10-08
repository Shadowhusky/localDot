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
#include "keychain_acl_darwin.h"
#include "keychain_identity_darwin.h"
#ifdef KEYD_NATIVE_TRACE
#include <stdio.h>
#define KEYD_TRACE(phase) fprintf(stderr, "keychain-native %s status=%d\n", phase, (int)status)
#else
#define KEYD_TRACE(phase) ((void)0)
#endif

static const char *keyd_requirement =
  "identifier \"dev.localdot.keyd\" and anchor apple generic and "
  "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
  "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and "
  "certificate leaf[subject.OU] = \"87FD3FSZBG\"";

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

static const keyd_identity_checks keyd_process_checks = { getppid, keyd_check_self, keyd_check_process };

// Identity checks are deliberately before even selecting the default keychain. No PID argument,
// environment override, development bypass, generic security tool or unsigned fallback exists.
static OSStatus keyd_authorized(void) {
  CFStringRef text = CFStringCreateWithCString(NULL, keyd_requirement, kCFStringEncodingUTF8);
  SecRequirementRef requirement = NULL;
  OSStatus status = text ? SecRequirementCreateWithString(text, kSecCSDefaultFlags, &requirement) : errSecAllocate;
  if (status == errSecSuccess) status = keyd_identity_check(&keyd_process_checks, requirement);
  if (requirement) CFRelease(requirement);
  if (text) CFRelease(text);
  return status;
}

// Re-read the stored ACL and compare its pinned signing requirement, independent of the
// previous release's descriptive executable path. Unknown or widened policies require migration.
static OSStatus keyd_verify_access(SecKeychainItemRef item) {
  SecAccessRef access = NULL;
  OSStatus status = SecKeychainItemCopyAccess(item, &access);
  if (status == errSecSuccess) status = keyd_acl_policy(access, keyd_requirement);
  if (access) CFRelease(access);
  return status;
}

static OSStatus keyd_item(const char *operation, const char *service, const char *account,
                         const void *data, unsigned int length, void **output, unsigned int *outputLength,
                         int *mayHaveChanged) {
  OSStatus status = keyd_authorized();
  KEYD_TRACE("authorized");
  if (status != errSecSuccess) return status;
  if (strcmp(operation, "check") == 0) return errSecSuccess;
  // A locked keychain or legacy ACL must fail visibly in the caller, never pop a hidden prompt.
  status = SecKeychainSetUserInteractionAllowed(false);
  SecKeychainRef keychain = NULL;
  SecTrustedApplicationRef self = NULL;
  CFArrayRef trusted = NULL;
  SecAccessRef access = NULL;
  SecKeychainItemRef item = NULL;
  if (status == errSecSuccess) status = SecKeychainCopyDefault(&keychain);
  KEYD_TRACE("default-keychain");
  if (status == errSecSuccess) status = SecTrustedApplicationCreateFromPath(NULL, &self);
  if (status == errSecSuccess) {
    const void *apps[] = { self };
    trusted = CFArrayCreate(NULL, apps, 1, &kCFTypeArrayCallBacks);
    if (!trusted) status = errSecAllocate;
  }
  if (status == errSecSuccess) status = SecAccessCreate(CFSTR("localDot secret — keyd only"), trusted, &access);
  KEYD_TRACE("access-created");
  if (status == errSecSuccess) {
    status = SecKeychainFindGenericPassword(keychain, (UInt32)strlen(service), service,
      (UInt32)strlen(account), account, NULL, NULL, &item);
    KEYD_TRACE("find");
    if (status == errSecItemNotFound && strcmp(operation, "store") == 0) {
      SecKeychainAttribute attributes[] = {
        { kSecServiceItemAttr, (UInt32)strlen(service), (void *)service },
        { kSecAccountItemAttr, (UInt32)strlen(account), (void *)account }
      };
      SecKeychainAttributeList list = { 2, attributes };
      *mayHaveChanged = 1;
      status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list,
        length, data, keychain, access, &item);
      KEYD_TRACE("create-item");
      // Creation supplies the restricted ACL atomically. Do not reapply the write below.
      if (status == errSecSuccess) { status = keyd_verify_access(item); KEYD_TRACE("created-policy"); goto done; }
    } else if (status == errSecSuccess) {
      // A matching stored policy already restricts value access to signed keyd. Replacing
      // that policy on every read unnecessarily asks for ACL-owner authorization, which
      // can fail even while the item's existing decrypt grant correctly authorizes us.
      // Only a nonmatching policy needs migration; verify the stored result before any
      // value access. Never interpret failed migration as an absent or readable item.
      status = keyd_verify_access(item);
      KEYD_TRACE("inspect-access");
      if (status != errSecSuccess) {
        SecAccessRef existing = NULL;
        status = SecKeychainItemCopyAccess(item, &existing);
        if (status == errSecSuccess) status = keyd_acl_restrict(existing, trusted, keyd_requirement);
        if (status == errSecSuccess) status = SecKeychainItemSetAccess(item, existing);
        KEYD_TRACE("set-access");
        if (existing) CFRelease(existing);
        if (status == errSecSuccess) status = keyd_verify_access(item);
      }
      KEYD_TRACE("existing-policy");
      if (status == errSecSuccess && strcmp(operation, "store") == 0) {
        *mayHaveChanged = 1;
        status = SecKeychainItemModifyAttributesAndData(item, NULL, length, data);
      } else if (status == errSecSuccess && strcmp(operation, "delete") == 0) {
        *mayHaveChanged = 1;
        status = SecKeychainItemDelete(item);
      } else if (status == errSecSuccess && strcmp(operation, "read") == 0)
        status = SecKeychainItemCopyAttributesAndData(item, NULL, NULL, NULL, outputLength, output);
    }
  }
done:
  KEYD_TRACE("done");
  if (item) CFRelease(item);
  if (access) CFRelease(access);
  if (trusted) CFRelease(trusted);
  if (self) CFRelease(self);
  if (keychain) CFRelease(keychain);
  return status;
}
static void keyd_free_output(void *output, unsigned int length) {
  if (output) {
    volatile unsigned char *bytes = (volatile unsigned char *)output;
    for (unsigned int i = 0; i < length; i++) bytes[i] = 0;
    SecKeychainItemFreeAttributesAndData(NULL, output);
  }
}
*/
import "C"

import "unsafe"

func nativeKeychainItem(operation, service, account string, data []byte) ([]byte, int) {
	op, svc, acct := C.CString(operation), C.CString(service), C.CString(account)
	defer C.free(unsafe.Pointer(op))
	defer C.free(unsafe.Pointer(svc))
	defer C.free(unsafe.Pointer(acct))
	var input unsafe.Pointer
	if len(data) > 0 {
		input = unsafe.Pointer(&data[0])
	}
	var output unsafe.Pointer
	var length C.uint
	var mayHaveChanged C.int
	status := C.keyd_item(op, svc, acct, input, C.uint(len(data)), &output, &length, &mayHaveChanged)
	defer C.keyd_free_output(output, length)
	if code := nativeExit(int32(status), mayHaveChanged != 0); code != 0 {
		return nil, code
	}
	if length > helperItemLimit {
		return nil, 1
	}
	if operation != "read" {
		return nil, 0
	}
	if output == nil || length == 0 {
		return nil, 1
	}
	return C.GoBytes(output, C.int(length)), 0
}

const nativeItemNotFound = int32(C.errSecItemNotFound)

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
	}
	return helperUnchanged
}

// Used by an unsigned test executable to check the denial path without opening any keychain.
func nativeKeychainAuthorized() bool { return C.keyd_authorized() == C.errSecSuccess }
