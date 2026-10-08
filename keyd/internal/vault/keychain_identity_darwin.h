#include <Security/Security.h>
#include <unistd.h>

// The identity gate's order, apart from the processes it inspects, so an unsigned fixture can
// drive every branch: production passes getppid and real code-signing checks.
typedef struct {
  pid_t (*parent)(void);
  OSStatus (*check_self)(SecRequirementRef requirement);
  OSStatus (*check_process)(pid_t pid, SecRequirementRef requirement);
} keyd_identity_checks;

// Signed keyd runs with the hardened runtime and no entitlements, so nothing can be injected into it.
static OSStatus keyd_signing_info(CFDictionaryRef info) {
  CFTypeRef flags = info ? CFDictionaryGetValue(info, kSecCodeInfoFlags) : NULL;
  CFTypeRef entitlements = info ? CFDictionaryGetValue(info, kSecCodeInfoEntitlementsDict) : NULL;
  int value = 0;
  if (!flags || CFGetTypeID(flags) != CFNumberGetTypeID() ||
      !CFNumberGetValue((CFNumberRef)flags, kCFNumberIntType, &value) ||
      !(value & kSecCodeSignatureRuntime) ||
      (entitlements && (CFGetTypeID(entitlements) != CFDictionaryGetTypeID() ||
       CFDictionaryGetCount((CFDictionaryRef)entitlements) != 0))) return errSecAuthFailed;
  return errSecSuccess;
}

// The parent is read once and must still be this process's parent after both checks: a parent
// that exits during them cannot lend its identity to whatever inherits its child.
static OSStatus keyd_identity_check(const keyd_identity_checks *checks, SecRequirementRef requirement) {
  pid_t parentPID = checks->parent();
  if (parentPID <= 1 || getuid() != geteuid()) return errSecAuthFailed;
  OSStatus status = checks->check_self(requirement);
  if (status == errSecSuccess) status = checks->check_process(parentPID, requirement);
  if (checks->parent() != parentPID) status = errSecAuthFailed;
  return status;
}
