#include <CommonCrypto/CommonDigest.h>
#include <Security/Security.h>
#include <libproc.h>
#include <stdint.h>
#include <stdio.h>
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
static OSStatus keyd_identity_check(const keyd_identity_checks *checks, SecRequirementRef requirement,
                                    int checkOnly, pid_t *checked) {
  pid_t parentPID = checks->parent();
  if (parentPID <= 1 || getuid() != geteuid()) return errSecAuthFailed;
  OSStatus status = checks->check_self(requirement);
  if (status == errSecSuccess) status = checks->check_process(parentPID, requirement);
  if (status == errSecSuccess) status = checks->check_mode(parentPID, checkOnly);
  if (checks->parent() != parentPID) status = errSecAuthFailed;
  if (status == errSecSuccess) *checked = parentPID;
  return status;
}

// The session: a keyd daemon claims the Keychain service when it starts, recording its process
// and the digest of a secret it made for this start. It hands the secret to each helper it runs
// on an inherited descriptor, so an item operation runs only for the daemon that holds the
// claim, and only when that daemon meant to run this helper. A claim stands while its daemon
// runs: a second keyd daemon, whatever its home, cannot claim the service until the first exits.
#define KEYD_SESSION_SECRET 32
#define KEYD_SESSION_ACCOUNT "_session"

typedef struct {
  pid_t pid;
  uint64_t sec;
  uint32_t usec;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
} keyd_session;

// When a process started, which tells it apart from a later process given the same PID.
typedef int (*keyd_process_started)(pid_t pid, uint64_t *sec, uint32_t *usec);

static int keyd_started(pid_t pid, uint64_t *sec, uint32_t *usec) {
  struct proc_bsdinfo info;
  if (pid <= 1 || proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info) ||
      (pid_t)info.pbi_pid != pid) return 0;
  *sec = info.pbi_start_tvsec;
  *usec = (uint32_t)info.pbi_start_tvusec;
  return 1;
}

static void keyd_session_digest(const unsigned char *secret, unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256(secret, KEYD_SESSION_SECRET, digest);
}

// "keyd-session:1:<pid>:<seconds>.<microseconds>:<sha-256 of the secret, lower-case hex>"
static int keyd_session_format(const keyd_session *s, char *out, size_t size) {
  int n = snprintf(out, size, "keyd-session:1:%d:%llu.%06u:", (int)s->pid, (unsigned long long)s->sec, s->usec);
  if (n < 0 || (size_t)n + 2 * CC_SHA256_DIGEST_LENGTH >= size) return 0;
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) snprintf(out + n + 2 * i, 3, "%02x", s->digest[i]);
  return n + 2 * CC_SHA256_DIGEST_LENGTH;
}

static int keyd_decimal(const char **p, const char *end, uint64_t max, uint64_t *out) {
  const char *start = *p;
  uint64_t value = 0;
  while (*p < end && **p >= '0' && **p <= '9') {
    if (value > (max - (uint64_t)(**p - '0')) / 10) return 0;
    value = value * 10 + (uint64_t)(**p - '0');
    (*p)++;
  }
  *out = value;
  return *p > start && *p - start <= 20 && !(*start == '0' && *p - start > 1);
}

static int keyd_session_parse(const char *data, size_t length, keyd_session *out) {
  static const char prefix[] = "keyd-session:1:";
  const char *p = data, *end = data + length;
  uint64_t pid = 0, sec = 0, usec = 0;
  if (!data || length < sizeof(prefix) - 1 || memcmp(data, prefix, sizeof(prefix) - 1) != 0) return 0;
  p += sizeof(prefix) - 1;
  if (!keyd_decimal(&p, end, INT32_MAX, &pid) || pid <= 1 || p >= end || *p++ != ':') return 0;
  if (!keyd_decimal(&p, end, UINT64_MAX / 2, &sec) || p >= end || *p++ != '.') return 0;
  for (int i = 0; i < 6; i++, p++) {
    if (p >= end || *p < '0' || *p > '9') return 0;
    usec = usec * 10 + (uint64_t)(*p - '0');
  }
  if (p >= end || *p++ != ':') return 0;
  if (end - p != 2 * CC_SHA256_DIGEST_LENGTH) return 0;
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
    unsigned value = 0;
    for (int j = 0; j < 2; j++) {
      char c = p[2 * i + j];
      if (c >= '0' && c <= '9') value = value * 16 + (unsigned)(c - '0');
      else if (c >= 'a' && c <= 'f') value = value * 16 + (unsigned)(c - 'a' + 10);
      else return 0;
    }
    out->digest[i] = (unsigned char)value;
  }
  out->pid = (pid_t)pid;
  out->sec = sec;
  out->usec = (uint32_t)usec;
  return 1;
}

// The record names this parent, started when it says, and the digest of the secret it handed over.
static int keyd_session_owns(const keyd_session *record, const keyd_session *parent) {
  unsigned char differ = 0;
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) differ |= record->digest[i] ^ parent->digest[i];
  return !differ && record->pid == parent->pid && record->sec == parent->sec && record->usec == parent->usec;
}

// A claim may replace a record whose daemon has exited, or that this same daemon made.
static int keyd_session_claimable(const keyd_session *record, const keyd_session *parent, keyd_process_started started) {
  uint64_t sec = 0;
  uint32_t usec = 0;
  if (record->pid == parent->pid && record->sec == parent->sec && record->usec == parent->usec) return 1;
  return !started(record->pid, &sec, &usec) || sec != record->sec || usec != record->usec;
}
