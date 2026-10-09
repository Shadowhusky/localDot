#include "keychain_acl_darwin.h"
#include "keychain_identity_darwin.h"

// The item operations behind keyd's Keychain helper, given a keychain, the requirement keyd meets
// now, the earlier keyd's requirement and the access that new items get. The helper passes keyd's
// own; a fixture can pass stand-ins without signing as keyd.
typedef struct {
  SecKeychainRef keychain;
  const char *service;
  const char *now;
  const char *earlier;
  SecAccessRef access;
} keyd_items;

// A refusal that names an item whose access list is neither keyd's nor the earlier keyd's: no keyd
// made it, so only storing the value again helps.
#define KEYD_NOT_OURS ((OSStatus)46)

enum { KEYD_OURS, KEYD_EARLIER, KEYD_FOREIGN };

static OSStatus keyd_find(const keyd_items *k, const char *service, const char *account, SecKeychainItemRef *item) {
  return SecKeychainFindGenericPassword(k->keychain, (UInt32)strlen(service), service,
    (UInt32)strlen(account), account, NULL, NULL, item);
}

static OSStatus keyd_owner(const keyd_items *k, SecKeychainItemRef item, int *owner) {
  SecAccessRef access = NULL;
  OSStatus status = SecKeychainItemCopyAccess(item, &access);
  if (status == errSecSuccess) {
    if (keyd_acl_policy(access, k->now) == errSecSuccess) *owner = KEYD_OURS;
    else if (keyd_acl_policy(access, k->earlier) == errSecSuccess) *owner = KEYD_EARLIER;
    else *owner = KEYD_FOREIGN;
  }
  if (access) CFRelease(access);
  return status;
}

// New items get keyd's access atomically at creation; the stored list is read back before use.
static OSStatus keyd_create(const keyd_items *k, const char *service, const char *account,
                            const void *data, UInt32 length) {
  SecKeychainAttribute attributes[] = {
    { kSecServiceItemAttr, (UInt32)strlen(service), (void *)service },
    { kSecAccountItemAttr, (UInt32)strlen(account), (void *)account }
  };
  SecKeychainAttributeList list = { 2, attributes };
  SecKeychainItemRef item = NULL;
  int owner = KEYD_FOREIGN;
  OSStatus status = SecKeychainItemCreateFromContent(kSecGenericPasswordItemClass, &list, length, data,
    k->keychain, k->access, &item);
  if (status == errSecSuccess) status = keyd_owner(k, item, &owner);
  if (status == errSecSuccess && owner != KEYD_OURS) status = errSecAuthFailed;
  if (item) CFRelease(item);
  return status;
}

static void keyd_free(void *data, UInt32 length) {
  if (!data) return;
  volatile unsigned char *bytes = (volatile unsigned char *)data;
  for (UInt32 i = 0; i < length; i++) bytes[i] = 0;
  SecKeychainItemFreeAttributesAndData(NULL, data);
}

// Reads an item keyd owns now. An earlier keyd's item is refused until it is adopted.
static OSStatus keyd_read(const keyd_items *k, const char *service, const char *account, void **data, UInt32 *length) {
  SecKeychainItemRef item = NULL;
  int owner = KEYD_FOREIGN;
  OSStatus status = keyd_find(k, service, account, &item);
  if (status == errSecSuccess) status = keyd_owner(k, item, &owner);
  if (status == errSecSuccess && owner == KEYD_EARLIER) status = errSecAuthFailed;
  else if (status == errSecSuccess && owner == KEYD_FOREIGN) status = KEYD_NOT_OURS;
  if (status == errSecSuccess) status = SecKeychainItemCopyAttributesAndData(item, NULL, NULL, NULL, length, data);
  if (item) CFRelease(item);
  return status;
}

// Stores data under account. An item keyd owns is rewritten in place; any other is replaced, since
// what keyd stores now takes its place either way, and its access list is never changed in place
// (that needs the user at a Keychain prompt).
static OSStatus keyd_store(const keyd_items *k, const char *service, const char *account,
                           const void *data, UInt32 length, int *mayHaveChanged) {
  SecKeychainItemRef item = NULL;
  int owner = KEYD_FOREIGN;
  OSStatus status = keyd_find(k, service, account, &item);
  if (status == errSecItemNotFound) {
    *mayHaveChanged = 1;
    return keyd_create(k, service, account, data, length);
  }
  if (status == errSecSuccess) status = keyd_owner(k, item, &owner);
  if (status == errSecSuccess) {
    *mayHaveChanged = 1;
    if (owner == KEYD_OURS) {
      status = SecKeychainItemModifyAttributesAndData(item, NULL, length, data);
    } else {
      status = SecKeychainItemDelete(item);
      if (status == errSecSuccess) status = keyd_create(k, service, account, data, length);
    }
  }
  if (item) CFRelease(item);
  return status;
}

static OSStatus keyd_delete(const keyd_items *k, const char *service, const char *account, int *mayHaveChanged) {
  SecKeychainItemRef item = NULL;
  OSStatus status = keyd_find(k, service, account, &item);
  if (status == errSecSuccess) {
    *mayHaveChanged = 1;
    status = SecKeychainItemDelete(item);
  }
  if (item) CFRelease(item);
  return status;
}

static OSStatus keyd_session_of(const keyd_items *k, keyd_session *record) {
  void *data = NULL;
  UInt32 length = 0;
  OSStatus status = keyd_read(k, k->service, KEYD_SESSION_ACCOUNT, &data, &length);
  if (status == errSecSuccess && !keyd_session_parse(data, length, record)) status = errSecDecode;
  keyd_free(data, length);
  return status;
}

// Item operations run only for the daemon that holds the claim, with the secret it handed over.
static OSStatus keyd_check_session(const keyd_items *k, const keyd_session *parent) {
  keyd_session record;
  OSStatus status = keyd_session_of(k, &record);
  if (status != errSecSuccess || !keyd_session_owns(&record, parent)) return errSecAuthFailed;
  return errSecSuccess;
}

// A daemon claims the service for its life. While another daemon that holds the claim still runs,
// the claim is refused; a record that is not keyd's own, or that it cannot read, is replaced.
static OSStatus keyd_claim(const keyd_items *k, const keyd_session *parent, keyd_process_started started,
                           int *mayHaveChanged) {
  char text[160];
  int length = keyd_session_format(parent, text, sizeof(text));
  SecKeychainItemRef item = NULL;
  int owner = KEYD_FOREIGN;
  keyd_session record;
  if (!length) return errSecParam;
  OSStatus status = keyd_find(k, k->service, KEYD_SESSION_ACCOUNT, &item);
  if (status == errSecSuccess) status = keyd_owner(k, item, &owner);
  if (item) CFRelease(item);
  if (status == errSecSuccess && owner == KEYD_OURS && keyd_session_of(k, &record) == errSecSuccess &&
      !keyd_session_claimable(&record, parent, started)) return errSecAuthFailed;
  if (status != errSecSuccess && status != errSecItemNotFound) return status;
  status = keyd_store(k, k->service, KEYD_SESSION_ACCOUNT, text, (UInt32)length, mayHaveChanged);
  if (status == errSecSuccess) status = keyd_check_session(k, parent);
  return status;
}

static int keyd_adoptable(const char *account) {
  size_t n = strlen(account);
  if (n < 1 || n > 66 || !((account[0] >= 'a' && account[0] <= 'z') || (account[0] >= '0' && account[0] <= '9')))
    return strcmp(account, "_bindings") == 0;
  for (size_t i = 0; i < n; i++) {
    char c = account[i];
    int name = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
    if (c == '.' && i == n - 2 && account[n - 1] >= '0' && account[n - 1] <= '5') return i <= 64;
    if (!name) return 0;
  }
  return n <= 64;
}

// The items of service, as their accounts; at most 4096.
static OSStatus keyd_accounts(const keyd_items *k, const char *service, CFArrayRef *out) {
  CFStringRef name = CFStringCreateWithCString(NULL, service, kCFStringEncodingUTF8);
  const void *searched[] = { k->keychain };
  CFArrayRef list = CFArrayCreate(NULL, searched, 1, &kCFTypeArrayCallBacks);
  CFDictionaryRef query = NULL;
  CFTypeRef found = NULL;
  OSStatus status = name && list ? errSecSuccess : errSecAllocate;
  if (status == errSecSuccess) {
    const void *keys[] = { kSecClass, kSecAttrService, kSecMatchLimit, kSecReturnAttributes, kSecMatchSearchList };
    const void *values[] = { kSecClassGenericPassword, name, kSecMatchLimitAll, kCFBooleanTrue, list };
    query = CFDictionaryCreate(NULL, keys, values, 5, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!query) status = errSecAllocate;
  }
  if (status == errSecSuccess) status = SecItemCopyMatching(query, &found);
  if (status == errSecItemNotFound) {
    status = errSecSuccess;
    *out = CFArrayCreate(NULL, NULL, 0, &kCFTypeArrayCallBacks);
  } else if (status == errSecSuccess) {
    if (!found || CFGetTypeID(found) != CFArrayGetTypeID() || CFArrayGetCount((CFArrayRef)found) > 4096) {
      status = errSecInternalComponent;
    } else {
      CFMutableArrayRef accounts = CFArrayCreateMutable(NULL, 0, &kCFTypeArrayCallBacks);
      for (CFIndex i = 0; accounts && i < CFArrayGetCount((CFArrayRef)found); i++) {
        CFDictionaryRef attributes = CFArrayGetValueAtIndex((CFArrayRef)found, i);
        CFTypeRef account = CFGetTypeID(attributes) == CFDictionaryGetTypeID() ?
          CFDictionaryGetValue(attributes, kSecAttrAccount) : NULL;
        if (account && CFGetTypeID(account) == CFStringGetTypeID()) CFArrayAppendValue(accounts, account);
      }
      *out = accounts;
    }
  }
  if (status == errSecSuccess && !*out) status = errSecAllocate;
  if (found) CFRelease(found);
  if (query) CFRelease(query);
  if (list) CFRelease(list);
  if (name) CFRelease(name);
  return status;
}

// A staged item puts back the item it was staged for, unless keyd already made that again. A staged
// item keyd did not make is dropped.
static OSStatus keyd_unstage(const keyd_items *k, const char *staging, const char *account, int *mayHaveChanged) {
  SecKeychainItemRef staged = NULL, item = NULL;
  int stagedOwner = KEYD_FOREIGN, owner = KEYD_FOREIGN;
  void *data = NULL;
  UInt32 length = 0;
  OSStatus status = keyd_find(k, staging, account, &staged);
  if (status == errSecSuccess) status = keyd_owner(k, staged, &stagedOwner);
  if (status == errSecSuccess && stagedOwner == KEYD_OURS) {
    status = SecKeychainItemCopyAttributesAndData(staged, NULL, NULL, NULL, &length, &data);
    if (status == errSecSuccess) status = keyd_find(k, k->service, account, &item);
    if (status == errSecSuccess) status = keyd_owner(k, item, &owner);
    if (status == errSecItemNotFound || (status == errSecSuccess && owner != KEYD_OURS))
      status = keyd_store(k, k->service, account, data, length, mayHaveChanged);
  }
  if (status == errSecSuccess) {
    *mayHaveChanged = 1;
    status = SecKeychainItemDelete(staged);
  }
  keyd_free(data, length);
  if (item) CFRelease(item);
  if (staged) CFRelease(staged);
  return status;
}

// keyd_adopt moves each item of the service that only the earlier keyd's access list protects to
// keyd's own. The earlier list trusts every earlier keyd, including any that can run another
// program as keyd's child; this keyd meets it too, so it reads the value, stages it in an item only
// it can read, deletes the item, makes it again and drops the staged copy. A move cut short leaves
// the staged copy, which the next run puts back first.
static OSStatus keyd_adopt(const keyd_items *k, unsigned *moved, int *mayHaveChanged) {
  char staging[96];
  CFArrayRef accounts = NULL;
  if (snprintf(staging, sizeof(staging), "%s.moving", k->service) >= (int)sizeof(staging)) return errSecParam;
  OSStatus status = keyd_accounts(k, staging, &accounts);
  for (CFIndex i = 0; status == errSecSuccess && i < CFArrayGetCount(accounts); i++) {
    char account[80];
    if (!CFStringGetCString(CFArrayGetValueAtIndex(accounts, i), account, sizeof(account), kCFStringEncodingUTF8) ||
        !keyd_adoptable(account)) continue;
    status = keyd_unstage(k, staging, account, mayHaveChanged);
  }
  if (accounts) CFRelease(accounts);
  accounts = NULL;
  if (status == errSecSuccess) status = keyd_accounts(k, k->service, &accounts);
  for (CFIndex i = 0; status == errSecSuccess && i < CFArrayGetCount(accounts); i++) {
    char account[80];
    SecKeychainItemRef item = NULL;
    int owner = KEYD_FOREIGN;
    void *data = NULL;
    UInt32 length = 0;
    if (!CFStringGetCString(CFArrayGetValueAtIndex(accounts, i), account, sizeof(account), kCFStringEncodingUTF8) ||
        !keyd_adoptable(account)) continue;
    status = keyd_find(k, k->service, account, &item);
    if (status == errSecSuccess) status = keyd_owner(k, item, &owner);
    if (status == errSecSuccess && owner == KEYD_EARLIER) {
      status = SecKeychainItemCopyAttributesAndData(item, NULL, NULL, NULL, &length, &data);
      if (status == errSecSuccess) status = keyd_store(k, staging, account, data, length, mayHaveChanged);
      if (status == errSecSuccess) status = SecKeychainItemDelete(item);
      if (status == errSecSuccess) status = keyd_create(k, k->service, account, data, length);
      if (status == errSecSuccess) status = keyd_delete(k, staging, account, mayHaveChanged);
      if (status == errSecSuccess) (*moved)++;
    }
    keyd_free(data, length);
    if (item) CFRelease(item);
  }
  if (accounts) CFRelease(accounts);
  return status;
}
