#include "keychain_identity_darwin.h"
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;

static pid_t parents[2];
static int parentReads, selfCalls, processCalls, modeCalls, modeCheckOnly;
static pid_t checkedPID, modePID;
static OSStatus selfResult, processResult, modeResult;

static pid_t parent(void) { return parents[parentReads++ == 0 ? 0 : 1]; }
static OSStatus checkSelf(SecRequirementRef requirement) {
  (void)requirement; selfCalls++; return selfResult;
}
static OSStatus checkProcess(pid_t pid, SecRequirementRef requirement) {
  (void)requirement; processCalls++; checkedPID = pid; return processResult;
}
static OSStatus checkMode(pid_t pid, int checkOnly) {
  modeCalls++; modePID = pid; modeCheckOnly = checkOnly; return modeResult;
}
static const keyd_identity_checks checks = {parent, checkSelf, checkProcess, checkMode};

static CFDictionaryRef info(CFTypeRef flags, CFTypeRef entitlements) {
  CFMutableDictionaryRef d = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (flags) CFDictionarySetValue(d, kSecCodeInfoFlags, flags);
  if (entitlements) CFDictionarySetValue(d, kSecCodeInfoEntitlementsDict, entitlements);
  return d;
}
static CFNumberRef number(int value) { return CFNumberCreate(NULL, kCFNumberIntType, &value); }

// procargs lays out a KERN_PROCARGS2 record; terminate=0 leaves the last argument unterminated.
static size_t procargs(char *out, int argc, const char *const *args, int count, int terminate) {
  size_t n = 0;
  memcpy(out, &argc, sizeof(argc)); n += sizeof(argc);
  const char *path = "/opt/keyd";
  memcpy(out + n, path, strlen(path) + 1); n += strlen(path) + 1;
  memset(out + n, 0, 3); n += 3;
  for (int i = 0; i < count; i++) {
    size_t len = strlen(args[i]) + (i + 1 < count || terminate ? 1 : 0);
    memcpy(out + n, args[i], len); n += len;
  }
  return n;
}

static pid_t livePID;
static uint64_t liveSec;
static uint32_t liveUsec;
// A stand-in for the process table: livePID runs, started at liveSec.liveUsec; nothing else does.
static int startedAs(pid_t pid, uint64_t *sec, uint32_t *usec) {
  if (pid != livePID) return 0;
  *sec = liveSec; *usec = liveUsec; return 1;
}

static int sessions(void) {
  keyd_session a = { .pid = 4242, .sec = 1760000000, .usec = 7 }, parsed;
  unsigned char secret[KEYD_SESSION_SECRET];
  for (int i = 0; i < KEYD_SESSION_SECRET; i++) secret[i] = (unsigned char)(i * 7);
  keyd_session_digest(secret, a.digest);
  char text[160];
  int n = keyd_session_format(&a, text, sizeof(text));
  if (n <= 0 || strncmp(text, "keyd-session:1:4242:1760000000.000007:", 38) != 0 ||
      !keyd_session_parse(text, (size_t)n, &parsed) || !keyd_session_owns(&parsed, &a)) {
    fprintf(stderr, "session round trip failed: %s\n", text); return 1;
  }
  printf("PASS session round trip\n");
  char digest[65];
  memcpy(digest, text + 38, 64); digest[64] = 0;
  struct { const char *name; char value[200]; } bad[] = {
    {"another prefix", ""}, {"another version", ""}, {"no parent", ""}, {"launchd as parent", ""},
    {"leading zero", ""}, {"five-digit microseconds", ""}, {"seven-digit microseconds", ""},
    {"capital hex", ""}, {"short digest", ""}, {"long digest", ""}, {"no seconds", ""},
    {"huge pid", ""}, {"sign", ""}, {"trailing text", ""},
  };
  snprintf(bad[0].value, 200, "keyd-sessions:1:4242:1760000000.000007:%s", digest);
  snprintf(bad[1].value, 200, "keyd-session:2:4242:1760000000.000007:%s", digest);
  snprintf(bad[2].value, 200, "keyd-session:1:0:1760000000.000007:%s", digest);
  snprintf(bad[3].value, 200, "keyd-session:1:1:1760000000.000007:%s", digest);
  snprintf(bad[4].value, 200, "keyd-session:1:04242:1760000000.000007:%s", digest);
  snprintf(bad[5].value, 200, "keyd-session:1:4242:1760000000.00007:%s", digest);
  snprintf(bad[6].value, 200, "keyd-session:1:4242:1760000000.0000007:%s", digest);
  snprintf(bad[7].value, 200, "keyd-session:1:4242:1760000000.000007:%s", digest);
  for (char *c = bad[7].value + 38; *c; c++) if (*c >= 'a' && *c <= 'f') *c -= 32;
  snprintf(bad[8].value, 200, "keyd-session:1:4242:1760000000.000007:%.63s", digest);
  snprintf(bad[9].value, 200, "keyd-session:1:4242:1760000000.000007:%s0", digest);
  snprintf(bad[10].value, 200, "keyd-session:1:4242:.000007:%s", digest);
  snprintf(bad[11].value, 200, "keyd-session:1:99999999999:1760000000.000007:%s", digest);
  snprintf(bad[12].value, 200, "keyd-session:1:-4242:1760000000.000007:%s", digest);
  snprintf(bad[13].value, 200, "keyd-session:1:4242:1760000000.000007:%s\n", digest);
  for (unsigned i = 0; i < sizeof(bad)/sizeof(bad[0]); i++) {
    if (keyd_session_parse(bad[i].value, strlen(bad[i].value), &parsed)) {
      fprintf(stderr, "session parse accepted: %s\n", bad[i].name); return 1;
    }
    printf("PASS session refuses %s\n", bad[i].name);
  }
  keyd_session other = a;
  other.digest[31] ^= 1;
  if (keyd_session_owns(&other, &a)) { fprintf(stderr, "another secret owns the session\n"); return 1; }
  other = a; other.pid = 4343;
  if (keyd_session_owns(&other, &a)) { fprintf(stderr, "another process owns the session\n"); return 1; }
  other = a; other.usec = 8;
  if (keyd_session_owns(&other, &a)) { fprintf(stderr, "a later process owns the session\n"); return 1; }
  printf("PASS session owned only by its process and secret\n");

  keyd_session holder = { .pid = 5000, .sec = 1760000001, .usec = 1 };
  livePID = 5000; liveSec = 1760000001; liveUsec = 1;
  if (keyd_session_claimable(&holder, &a, startedAs)) { fprintf(stderr, "a running daemon lost its claim\n"); return 1; }
  printf("PASS claim refused while its daemon runs\n");
  if (!keyd_session_claimable(&a, &a, startedAs)) { fprintf(stderr, "a daemon could not claim again\n"); return 1; }
  printf("PASS claim kept by the daemon that made it\n");
  liveUsec = 2;
  if (!keyd_session_claimable(&holder, &a, startedAs)) { fprintf(stderr, "a reused PID kept the claim\n"); return 1; }
  printf("PASS claim freed when its PID is reused\n");
  livePID = 0;
  if (!keyd_session_claimable(&holder, &a, startedAs)) { fprintf(stderr, "an exited daemon kept the claim\n"); return 1; }
  printf("PASS claim freed when its daemon exits\n");
  return 0;
}

static pid_t spawn(const char *path, char *const argv[]) {
  pid_t pid = 0;
  return posix_spawn(&pid, path, NULL, NULL, argv, environ) == 0 ? pid : -1;
}
static void reap(pid_t pid) {
  kill(pid, SIGKILL);
  waitpid(pid, NULL, 0);
}

int main(void) {
  setbuf(stdout, NULL);
  struct { const char *name; pid_t first, second; OSStatus self, process, mode; int checkOnly, ok, selfCalls, processCalls, modeCalls; } gates[] = {
    {"signed self and daemon parent", 4242, 4242, errSecSuccess, errSecSuccess, errSecSuccess, 0, 1, 1, 1, 1},
    {"signed self and daemon parent, check", 4242, 4242, errSecSuccess, errSecSuccess, errSecSuccess, 1, 1, 1, 1, 1},
    {"unsigned self", 4242, 4242, errSecCSReqFailed, errSecSuccess, errSecSuccess, 0, 0, 1, 0, 0},
    {"unsigned parent", 4242, 4242, errSecSuccess, errSecCSReqFailed, errSecSuccess, 0, 0, 1, 1, 0},
    {"signed launcher parent", 4242, 4242, errSecSuccess, errSecSuccess, errSecAuthFailed, 0, 0, 1, 1, 1},
    {"signed launcher parent, check", 4242, 4242, errSecSuccess, errSecSuccess, errSecAuthFailed, 1, 0, 1, 1, 1},
    {"parent exited during the checks", 4242, 1, errSecSuccess, errSecSuccess, errSecSuccess, 0, 0, 1, 1, 1},
    {"parent replaced during the checks", 4242, 4343, errSecSuccess, errSecSuccess, errSecSuccess, 0, 0, 1, 1, 1},
    {"orphaned", 1, 1, errSecSuccess, errSecSuccess, errSecSuccess, 0, 0, 0, 0, 0},
    {"no parent", 0, 0, errSecSuccess, errSecSuccess, errSecSuccess, 0, 0, 0, 0, 0},
  };
  for (unsigned i = 0; i < sizeof(gates)/sizeof(gates[0]); i++) {
    parents[0] = gates[i].first; parents[1] = gates[i].second;
    parentReads = selfCalls = processCalls = modeCalls = 0; checkedPID = modePID = 0; modeCheckOnly = -1;
    selfResult = gates[i].self; processResult = gates[i].process; modeResult = gates[i].mode;
    pid_t checked = 0;
    OSStatus status = keyd_identity_check(&checks, NULL, gates[i].checkOnly, &checked);
    if ((status == errSecSuccess) != gates[i].ok || checked != (gates[i].ok ? gates[i].first : 0) ||
        selfCalls != gates[i].selfCalls ||
        processCalls != gates[i].processCalls || modeCalls != gates[i].modeCalls ||
        (processCalls && checkedPID != gates[i].first) ||
        (modeCalls && (modePID != gates[i].first || modeCheckOnly != gates[i].checkOnly))) {
      fprintf(stderr, "unexpected identity result: %s status=%d\n", gates[i].name, (int)status); return 1;
    }
    printf("PASS identity %s\n", gates[i].name);
  }

  const char *daemon[] = {"keyd", "-home", "/x"}, *bare[] = {"keyd"}, *run[] = {"keyd", "native-run"},
    *item[] = {"keyd", "keychain-item", "read", "localdot-keyd", "weather.0"}, *selfTest[] = {"keyd", "self-test", "-home", "/x"},
    *service[] = {"keyd", "service-exec", "/s", "/h", "o", "c", "keyd"}, *empty[] = {"keyd", ""};
  struct { const char *name; int argc; const char *const *args; int count, terminate, checkOnly, ok; } modes[] = {
    {"daemon flags", 3, daemon, 3, 1, 0, 1},
    {"daemon without flags", 1, bare, 1, 1, 0, 1},
    {"launcher subcommand", 2, run, 2, 1, 0, 0},
    {"launcher subcommand, check", 2, run, 2, 1, 1, 0},
    {"item helper as parent", 5, item, 5, 1, 0, 0},
    {"self-test, check", 4, selfTest, 4, 1, 1, 1},
    {"self-test, item operation", 4, selfTest, 4, 1, 0, 0},
    {"service launcher", 7, service, 7, 1, 0, 0},
    {"empty first argument", 2, empty, 2, 1, 0, 0},
    {"fewer arguments than argc", 3, daemon, 1, 1, 0, 0},
    {"unterminated argument", 2, run, 2, 0, 1, 0},
    {"unterminated daemon flag", 3, daemon, 2, 0, 0, 0},
    {"no arguments", 0, bare, 1, 1, 0, 0},
    {"negative argc", -1, bare, 1, 1, 0, 0},
    {"huge argc", 5000, daemon, 3, 1, 0, 0},
  };
  char record[512];
  for (unsigned i = 0; i < sizeof(modes)/sizeof(modes[0]); i++) {
    size_t length = procargs(record, modes[i].argc, modes[i].args, modes[i].count, modes[i].terminate);
    if (keyd_daemon_args(record, length, modes[i].checkOnly) != modes[i].ok) {
      fprintf(stderr, "unexpected mode result: %s\n", modes[i].name); return 1;
    }
    printf("PASS mode %s\n", modes[i].name);
  }
  if (keyd_daemon_args(NULL, 0, 1) || keyd_daemon_args(record, 3, 1)) {
    fprintf(stderr, "unexpected mode result: short record\n"); return 1;
  }
  printf("PASS mode short record\n");

  // The fixture runs without arguments, as a daemon would; real children carry their own.
  if (keyd_check_mode(getpid(), 0) != errSecSuccess) { fprintf(stderr, "own arguments refused\n"); return 1; }
  printf("PASS process own arguments\n");
  char *flagged[] = {"keyd", "-c", "sleep 30", NULL}, *subcommand[] = {"keyd", "30", NULL};
  pid_t shaped = spawn("/bin/sh", flagged), other = spawn("/bin/sleep", subcommand);
  OSStatus flaggedStatus = keyd_check_mode(shaped, 0), otherStatus = keyd_check_mode(other, 0);
  reap(shaped);
  reap(other);
  if (shaped <= 0 || other <= 0 || flaggedStatus != errSecSuccess || otherStatus == errSecSuccess) {
    fprintf(stderr, "unexpected process mode: flagged=%d other=%d\n", (int)flaggedStatus, (int)otherStatus); return 1;
  }
  printf("PASS process flags only\n");
  printf("PASS process with a subcommand\n");
  if (keyd_check_mode(other, 1) == errSecSuccess) { fprintf(stderr, "reaped process accepted\n"); return 1; }
  printf("PASS process gone\n");
  uint64_t sec = 0, childSec = 0;
  uint32_t usec = 0, childUsec = 0;
  char *nap[] = {"sleep", "30", NULL};
  pid_t child = spawn("/bin/sleep", nap);
  int ownStart = keyd_started(getpid(), &sec, &usec), childStart = keyd_started(child, &childSec, &childUsec);
  reap(child);
  if (!ownStart || !childStart || childSec < sec || keyd_started(child, &childSec, &childUsec) ||
      keyd_started(1, &sec, &usec) || keyd_started(0, &sec, &usec)) {
    fprintf(stderr, "process start times: own %d child %d\n", ownStart, childStart); return 1;
  }
  printf("PASS process start times\n");
  if (sessions()) return 1;

  CFNumberRef runtime = number(kSecCodeSignatureRuntime | kSecCodeSignatureLibraryValidation);
  CFNumberRef plain = number(kSecCodeSignatureLibraryValidation | kSecCodeSignatureRestrict);
  const void *key = CFSTR("com.apple.security.get-task-allow");
  const void *yes = kCFBooleanTrue;
  CFDictionaryRef none = CFDictionaryCreate(NULL, NULL, NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionaryRef some = CFDictionaryCreate(NULL, &key, &yes, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  struct { const char *name; CFDictionaryRef info; int ok; } signing[] = {
    {"hardened runtime", info(runtime, NULL), 1},
    {"hardened runtime with empty entitlements", info(runtime, none), 1},
    {"no hardened runtime", info(plain, NULL), 0},
    {"no flags", info(NULL, NULL), 0},
    {"flags of another type", info(CFSTR("runtime"), NULL), 0},
    {"an entitlement", info(runtime, some), 0},
    {"entitlements of another type", info(runtime, CFSTR("none")), 0},
    {"no signing information", NULL, 0},
  };
  for (unsigned i = 0; i < sizeof(signing)/sizeof(signing[0]); i++) {
    if ((keyd_signing_info(signing[i].info) == errSecSuccess) != signing[i].ok) {
      fprintf(stderr, "unexpected signing result: %s\n", signing[i].name); return 1;
    }
    if (signing[i].info) CFRelease(signing[i].info);
    printf("PASS signing %s\n", signing[i].name);
  }
  CFRelease(runtime); CFRelease(plain); CFRelease(none); CFRelease(some);
  return 0;
}
