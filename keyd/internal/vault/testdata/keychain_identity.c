#include "keychain_identity_darwin.h"
#include <stdio.h>

static pid_t parents[2];
static int parentReads, selfCalls, processCalls;
static pid_t checkedPID;
static OSStatus selfResult, processResult;

static pid_t parent(void) { return parents[parentReads++ == 0 ? 0 : 1]; }
static OSStatus checkSelf(SecRequirementRef requirement) {
  (void)requirement; selfCalls++; return selfResult;
}
static OSStatus checkProcess(pid_t pid, SecRequirementRef requirement) {
  (void)requirement; processCalls++; checkedPID = pid; return processResult;
}
static const keyd_identity_checks checks = {parent, checkSelf, checkProcess};

static CFDictionaryRef info(CFTypeRef flags, CFTypeRef entitlements) {
  CFMutableDictionaryRef d = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  if (flags) CFDictionarySetValue(d, kSecCodeInfoFlags, flags);
  if (entitlements) CFDictionarySetValue(d, kSecCodeInfoEntitlementsDict, entitlements);
  return d;
}
static CFNumberRef number(int value) { return CFNumberCreate(NULL, kCFNumberIntType, &value); }

int main(void) {
  setbuf(stdout, NULL);
  struct { const char *name; pid_t first, second; OSStatus self, process; int ok, selfCalls, processCalls; } gates[] = {
    {"signed self and parent", 4242, 4242, errSecSuccess, errSecSuccess, 1, 1, 1},
    {"unsigned self", 4242, 4242, errSecCSReqFailed, errSecSuccess, 0, 1, 0},
    {"unsigned parent", 4242, 4242, errSecSuccess, errSecCSReqFailed, 0, 1, 1},
    {"parent exited during the checks", 4242, 1, errSecSuccess, errSecSuccess, 0, 1, 1},
    {"parent replaced during the checks", 4242, 4343, errSecSuccess, errSecSuccess, 0, 1, 1},
    {"orphaned", 1, 1, errSecSuccess, errSecSuccess, 0, 0, 0},
    {"no parent", 0, 0, errSecSuccess, errSecSuccess, 0, 0, 0},
  };
  for (unsigned i = 0; i < sizeof(gates)/sizeof(gates[0]); i++) {
    parents[0] = gates[i].first; parents[1] = gates[i].second;
    parentReads = selfCalls = processCalls = 0; checkedPID = 0;
    selfResult = gates[i].self; processResult = gates[i].process;
    OSStatus status = keyd_identity_check(&checks, NULL);
    if ((status == errSecSuccess) != gates[i].ok || selfCalls != gates[i].selfCalls ||
        processCalls != gates[i].processCalls || (processCalls && checkedPID != gates[i].first)) {
      fprintf(stderr, "unexpected identity result: %s status=%d\n", gates[i].name, (int)status); return 1;
    }
    printf("PASS identity %s\n", gates[i].name);
  }

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
