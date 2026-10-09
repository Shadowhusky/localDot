#include "keychain_items_darwin.h"
#include <stdio.h>

// Drives keyd's item operations against a keychain it makes at argv[1] with a random password. It
// stands in for keyd now (itself: identifier keyd-items-fixture, KeydGeneration 2) and the earlier
// keyd (argv[2]: the same identifier without the generation), so it reads items the earlier keyd's
// access list protects, as keyd does. It never opens the login keychain, and it puts the user's
// keychain search list back as soon as the new keychain is made.
static const char *now = "identifier \"keyd-items-fixture\" and info [KeydGeneration] >= \"2\"";
static const char *earlier = "identifier \"keyd-items-fixture\"";
static const char *service = "localdot-keyd-test";
static const char *staging = "localdot-keyd-test.moving";

static pid_t livePID;
static int startedAs(pid_t pid, uint64_t *sec, uint32_t *usec) {
  if (pid != livePID) return 0;
  *sec = 1760000000; *usec = 1; return 1;
}

// The Keychain refuses keyd an item whose partition list does not name keyd, or one in a keychain the
// user cannot unlock. This fixture is not signed by a team, so it stands in for that refusal.
static OSStatus refusing(SecKeychainItemRef item, const char *account, void **data, UInt32 *length) {
  if (strncmp(account, "aaa-unreadable", 14) == 0) return errSecInteractionNotAllowed;
  return SecKeychainItemCopyAttributesAndData(item, NULL, NULL, NULL, length, data);
}

static SecAccessRef accessFor(const char *path) {
  SecTrustedApplicationRef app = NULL;
  SecAccessRef access = NULL;
  if (SecTrustedApplicationCreateFromPath(path, &app)) return NULL;
  const void *apps[] = { app };
  CFArrayRef trusted = CFArrayCreate(NULL, apps, 1, &kCFTypeArrayCallBacks);
  if (SecAccessCreate(CFSTR("fixture"), trusted, &access)) access = NULL;
  CFRelease(trusted); CFRelease(app);
  return access;
}

static int put(SecKeychainRef keychain, const char *svc, const char *account, const char *value, const char *trustedPath) {
  SecAccessRef access = accessFor(trustedPath);
  SecKeychainAttribute attributes[] = {
    { kSecServiceItemAttr, (UInt32)strlen(svc), (void *)svc },
    { kSecAccountItemAttr, (UInt32)strlen(account), (void *)account }
  };
  SecKeychainAttributeList list = { 2, attributes };
  SecKeychainItemRef item = NULL;
  int ok = access && SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list, (UInt32)strlen(value), value,
    keychain, access, &item) == errSecSuccess;
  if (item) CFRelease(item);
  if (access) CFRelease(access);
  return ok;
}

static int owned(const keyd_items *k, const char *svc, const char *account, int want) {
  SecKeychainItemRef item = NULL;
  int owner = -1;
  OSStatus status = keyd_find(k, svc, account, &item);
  if (status == errSecSuccess) status = keyd_owner(k, item, &owner);
  if (item) CFRelease(item);
  return status == errSecSuccess && owner == want;
}

static int holds(const keyd_items *k, const char *account, const char *want) {
  void *data = NULL;
  UInt32 length = 0;
  int ok = keyd_read(k, service, account, &data, &length) == errSecSuccess && length == strlen(want) &&
    memcmp(data, want, length) == 0;
  keyd_free(data, length);
  return ok;
}

static int absent(const keyd_items *k, const char *svc, const char *account) {
  SecKeychainItemRef item = NULL;
  OSStatus status = keyd_find(k, svc, account, &item);
  if (item) CFRelease(item);
  return status == errSecItemNotFound;
}

// lists reports whether list names exactly these accounts, one per line, in any order.
static int lists(const char *list, UInt32 length, const char *const *want, size_t count) {
  size_t lines = 0;
  for (UInt32 i = 0; i < length; i++) lines += list[i] == '\n';
  if (lines != count || (length && list[length - 1] != '\n')) return 0;
  for (size_t i = 0; i < count; i++) {
    size_t n = strlen(want[i]);
    int found = 0;
    for (UInt32 at = 0; !found && at + n < length; at++)
      found = (at == 0 || list[at - 1] == '\n') && memcmp(list + at, want[i], n) == 0 && list[at + n] == '\n';
    if (!found) return 0;
  }
  return 1;
}

#define CHECK(cond, name) do { if (!(cond)) { fprintf(stderr, "FAIL %s\n", name); return 1; } printf("PASS %s\n", name); } while (0)

static int run(SecKeychainRef keychain, const char *earlierPath) {
  int changed = 0;
  unsigned moved = 0, failed = 0;
  keyd_items k = { keychain, service, now, earlier, accessFor(NULL), refusing };
  CHECK(k.access, "keyd's access list");

  CHECK(keyd_store(&k, service, "weather", "keyd:aaaa:1", 11, &changed) == errSecSuccess &&
        owned(&k, service, "weather", KEYD_OURS) && holds(&k, "weather", "keyd:aaaa:1"), "store makes an item only keyd reads");
  CHECK(keyd_store(&k, service, "weather", "keyd:bbbb:1", 11, &changed) == errSecSuccess &&
        holds(&k, "weather", "keyd:bbbb:1"), "store rewrites keyd's item in place");

  // An earlier keyd's item and a staged one that keyd cannot read, made first and named to come first.
  CHECK(put(keychain, service, "aaa-unreadable", "keyd:9999:1", earlierPath) &&
        keyd_store(&k, staging, "aaa-unreadable.0", "9999:6162", 9, &changed) == errSecSuccess &&
        owned(&k, service, "aaa-unreadable", KEYD_EARLIER), "items keyd cannot read");
  CHECK(put(keychain, service, "deepseek", "keyd:cccc:2", earlierPath) && put(keychain, service, "deepseek.0", "cccc:6162", earlierPath) &&
        put(keychain, service, "deepseek.1", "cccc:6364", earlierPath) && owned(&k, service, "deepseek", KEYD_EARLIER),
        "items the earlier keyd stored");
  void *data = NULL;
  UInt32 length = 0;
  CHECK(keyd_read(&k, service, "deepseek", &data, &length) == errSecAuthFailed && !data, "an earlier keyd's item is refused until adopted");

  CHECK(put(keychain, service, "planted", "keyd:dddd:1", "/usr/bin/false") &&
        keyd_read(&k, service, "planted", &data, &length) == KEYD_NOT_OURS && !data, "an item no keyd made is refused as not keyd's");
  CHECK(keyd_store(&k, service, "planted", "keyd:eeee:1", 11, &changed) == errSecSuccess &&
        owned(&k, service, "planted", KEYD_OURS) && holds(&k, "planted", "keyd:eeee:1"), "store replaces an item no keyd made");
  CHECK(put(keychain, service, "orphan", "keyd:ffff:1", "/usr/bin/false"), "another item no keyd made");

  // A move cut short before it deleted weather.0, and one cut short after it deleted gone.0 and
  // before it made it again.
  CHECK(keyd_store(&k, staging, "weather.0", "aaaa:6566", 9, &changed) == errSecSuccess &&
        put(keychain, service, "weather.0", "aaaa:6566", earlierPath) &&
        keyd_store(&k, staging, "gone.0", "gggg:6768", 9, &changed) == errSecSuccess, "moves cut short");

  CHECK(keyd_adopt(&k, &moved, &failed, &changed) == errSecSuccess && moved == 3 && failed == 2,
        "adopt moves the earlier keyd's items past those it cannot read, and counts those");
  CHECK(owned(&k, service, "deepseek", KEYD_OURS) && owned(&k, service, "deepseek.0", KEYD_OURS) &&
        owned(&k, service, "deepseek.1", KEYD_OURS) && owned(&k, service, "weather.0", KEYD_OURS) &&
        holds(&k, "deepseek", "keyd:cccc:2") && holds(&k, "deepseek.0", "cccc:6162") && holds(&k, "deepseek.1", "cccc:6364") &&
        holds(&k, "weather.0", "aaaa:6566"), "adopted items keep their values and only keyd reads them");
  CHECK(holds(&k, "gone.0", "gggg:6768") && absent(&k, staging, "weather.0") && absent(&k, staging, "gone.0") &&
        absent(&k, staging, "deepseek"), "a move cut short is put back and its staged copy dropped");
  CHECK(owned(&k, service, "orphan", KEYD_FOREIGN), "adopt leaves an item no keyd made");
  CHECK(owned(&k, service, "aaa-unreadable", KEYD_EARLIER) && owned(&k, staging, "aaa-unreadable.0", KEYD_OURS),
        "an item adopt cannot read stays as it was");
  moved = failed = 0;
  CHECK(keyd_adopt(&k, &moved, &failed, &changed) == errSecSuccess && moved == 0 && failed == 2,
        "a second adopt moves nothing and counts again what it cannot read");

  keyd_session a = { .pid = 4242, .sec = 1760000000, .usec = 1 }, b = { .pid = 4343, .sec = 1760000000, .usec = 1 };
  unsigned char secret[KEYD_SESSION_SECRET] = {1};
  keyd_session_digest(secret, a.digest);
  secret[0] = 2;
  keyd_session_digest(secret, b.digest);
  CHECK(keyd_check_session(&k, &a) == errSecAuthFailed, "no item operation before a claim");
  livePID = 4242;
  CHECK(keyd_claim(&k, &a, startedAs, &changed) == errSecSuccess && keyd_check_session(&k, &a) == errSecSuccess &&
        keyd_check_session(&k, &b) == errSecAuthFailed, "a claim serves only its daemon");
  CHECK(keyd_claim(&k, &b, startedAs, &changed) == errSecAuthFailed && keyd_check_session(&k, &a) == errSecSuccess,
        "a second daemon cannot claim while the first runs");
  keyd_session forged = a;
  forged.digest[0] ^= 1;
  CHECK(keyd_check_session(&k, &forged) == errSecAuthFailed, "the claiming daemon's secret is required");
  livePID = 0;
  CHECK(keyd_claim(&k, &b, startedAs, &changed) == errSecSuccess && keyd_check_session(&k, &b) == errSecSuccess &&
        keyd_check_session(&k, &a) == errSecAuthFailed, "a claim passes on when its daemon exits");
  CHECK(keyd_delete(&k, service, KEYD_SESSION_ACCOUNT, &changed) == errSecSuccess &&
        put(keychain, service, KEYD_SESSION_ACCOUNT, "keyd-session:1:4343:1760000000.000001:00", "/usr/bin/false") &&
        keyd_check_session(&k, &b) == errSecAuthFailed && keyd_claim(&k, &a, startedAs, &changed) == errSecSuccess &&
        owned(&k, service, KEYD_SESSION_ACCOUNT, KEYD_OURS), "a claim no keyd made serves nobody and is replaced");

  const char *const heads[] = { "aaa-unreadable", "deepseek", "orphan", "planted", "weather" };
  void *names = NULL;
  UInt32 named = 0;
  CHECK(keyd_store(&k, service, "_bindings", "keyd-bindings", 13, &changed) == errSecSuccess &&
        keyd_list(&k, &names, &named) == errSecSuccess && lists(names, named, heads, 5),
        "list names every item that holds a secret's head, whoever made it, and no chunk, claim or marker");
  free(names);

  CHECK(keyd_delete(&k, service, "weather", &changed) == errSecSuccess && absent(&k, service, "weather") &&
        keyd_delete(&k, service, "orphan", &changed) == errSecSuccess && absent(&k, service, "orphan"), "delete removes any item");
  CFRelease(k.access);
  return 0;
}

int main(int argc, char **argv) {
  setbuf(stdout, NULL);
  if (argc != 3) return 2;
  // Nothing here may wait on a person: a prompt would be a failure, never an answer.
  alarm(60);
  char password[33];
  unsigned char bytes[16];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes)) return 1;
  for (int i = 0; i < 16; i++) snprintf(password + 2 * i, 3, "%02x", bytes[i]);
  CFArrayRef searchList = NULL;
  SecKeychainRef keychain = NULL;
  if (SecKeychainCopyDomainSearchList(kSecPreferencesDomainUser, &searchList)) return 1;
  OSStatus created = SecKeychainCreate(argv[1], (UInt32)strlen(password), password, false, NULL, &keychain);
  OSStatus restored = SecKeychainSetDomainSearchList(kSecPreferencesDomainUser, searchList);
  CFRelease(searchList);
  if (created || restored) { fprintf(stderr, "temporary keychain: %d, search list: %d\n", (int)created, (int)restored); return 1; }
  SecKeychainSetUserInteractionAllowed(false);
  int result = run(keychain, argv[2]);
  SecKeychainDelete(keychain);
  CFRelease(keychain);
  return result;
}
