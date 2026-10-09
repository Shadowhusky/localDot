#include <Security/Security.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

// The identity gate's order, apart from the processes it inspects, so an unsigned fixture can
// drive every branch: production passes getppid, real code-signing checks and the parent's mode.
typedef struct {
  pid_t (*parent)(void);
  OSStatus (*check_self)(SecRequirementRef requirement);
  OSStatus (*check_process)(pid_t pid, SecRequirementRef requirement);
  OSStatus (*check_mode)(pid_t pid, int checkOnly);
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

// A KERN_PROCARGS2 record holds argc, the executable path, NUL padding, then the arguments.
// keyd's daemon mode takes only flags and never starts a program its caller names, so only a
// daemon parent may drive an item operation; `keyd self-test` may run the identity check alone.
// Every other subcommand, including any added later, is refused as a parent.
static int keyd_daemon_args(const char *record, size_t length, int checkOnly) {
  int argc = 0;
  if (!record || length < sizeof(argc)) return 0;
  memcpy(&argc, record, sizeof(argc));
  if (argc < 1 || argc > 4096) return 0;
  size_t i = sizeof(argc);
  while (i < length && record[i]) i++;
  while (i < length && !record[i]) i++;
  const char *args[2] = { NULL, NULL };
  for (int n = 0; n < argc && n < 2; n++) {
    size_t start = i;
    while (i < length && record[i]) i++;
    if (i >= length) return 0;
    args[n] = record + start;
    i++;
  }
  if (argc == 1 || args[1][0] == '-') return 1;
  return checkOnly && strcmp(args[1], "self-test") == 0;
}

// The arguments the parent was started with. The hardened runtime keeps out the debugger and
// injected code that could rewrite them in a signed keyd.
static OSStatus keyd_check_mode(pid_t pid, int checkOnly) {
  int argmax = 0;
  size_t size = sizeof(argmax);
  int mib[3] = { CTL_KERN, KERN_ARGMAX, 0 };
  if (sysctl(mib, 2, &argmax, &size, NULL, 0) != 0 || argmax < 64 || argmax > (1 << 24)) return errSecAuthFailed;
  char *record = malloc((size_t)argmax);
  if (!record) return errSecAllocate;
  mib[1] = KERN_PROCARGS2;
  mib[2] = pid;
  size = (size_t)argmax;
  int daemon = sysctl(mib, 3, record, &size, NULL, 0) == 0 && keyd_daemon_args(record, size, checkOnly);
  free(record);
  return daemon ? errSecSuccess : errSecAuthFailed;
}

// The parent is read once and must still be this process's parent after every check: a parent
// that exits during them cannot lend its identity to whatever inherits its child.
static OSStatus keyd_identity_check(const keyd_identity_checks *checks, SecRequirementRef requirement, int checkOnly) {
  pid_t parentPID = checks->parent();
  if (parentPID <= 1 || getuid() != geteuid()) return errSecAuthFailed;
  OSStatus status = checks->check_self(requirement);
  if (status == errSecSuccess) status = checks->check_process(parentPID, requirement);
  if (status == errSecSuccess) status = checks->check_mode(parentPID, checkOnly);
  if (checks->parent() != parentPID) status = errSecAuthFailed;
  return status;
}
