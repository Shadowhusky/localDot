#include <Security/Security.h>
#include <Security/cssmapple.h>
#include <stdlib.h>
#include <string.h>

// Inspect the actual code-signing requirement through the public CSSM ACL representation.
// SecTrustedApplicationCopyData returns a descriptive path, not the stored requirement;
// comparing that path breaks updates and cannot establish the ACL's signing restriction.
// Apple Security's acl_codesigning.cpp defines the five-field modern signature subject.
static int keyd_acl_elements(const CSSM_LIST *list, const CSSM_LIST_ELEMENT **out, size_t count) {
  if (!list || !list->Head || !list->Tail) return 0;
  const CSSM_LIST_ELEMENT *next = list->Head;
  for (size_t i = 0; i < count; i++) {
    if (!next) return 0;
    out[i] = next;
    next = next->NextElement;
  }
  return !next && out[count - 1] == list->Tail;
}
static int keyd_acl_word(const CSSM_LIST_ELEMENT *element, CSSM_WORDID_TYPE value) {
  return element->ElementType == CSSM_LIST_ELEMENT_WORDID && element->WordID == value;
}
static int keyd_acl_datum(const CSSM_LIST_ELEMENT *element, size_t minimum, size_t maximum) {
  return element->ElementType == CSSM_LIST_ELEMENT_DATUM && element->Element.Word.Data &&
    element->Element.Word.Length >= minimum && element->Element.Word.Length <= maximum;
}
// codesign's generated requirement and the text compiler group an AND chain differently.
// Compare both through Security.framework's text representation, preserving all operators,
// parentheses and certificate predicates. Never compare just the current executable against
// the stored requirement: a widened requirement would also accept that executable.
static int keyd_acl_requirement(const CSSM_DATA *data, CFDataRef expected) {
  CFDataRef stored = CFDataCreate(NULL, data->Data, data->Length);
  SecRequirementRef actualRequirement = NULL, expectedRequirement = NULL;
  CFStringRef actualText = NULL, expectedText = NULL;
  OSStatus status = stored ? SecRequirementCreateWithData(stored, 0, &actualRequirement) : errSecAllocate;
  if (status == errSecSuccess) status = SecRequirementCreateWithData(expected, 0, &expectedRequirement);
  if (status == errSecSuccess) status = SecRequirementCopyString(actualRequirement, 0, &actualText);
  if (status == errSecSuccess) status = SecRequirementCopyString(expectedRequirement, 0, &expectedText);
  int matches = status == errSecSuccess && actualText && expectedText && CFEqual(actualText, expectedText);
  if (actualText) CFRelease(actualText);
  if (expectedText) CFRelease(expectedText);
  if (actualRequirement) CFRelease(actualRequirement);
  if (expectedRequirement) CFRelease(expectedRequirement);
  if (stored) CFRelease(stored);
  return matches;
}
static int keyd_acl_subject(const CSSM_LIST *subject, CFDataRef requirement) {
  const CSSM_LIST_ELEMENT *outer[5], *code[5], *prompt[3];
  if (!requirement || !keyd_acl_elements(subject, outer, 5) ||
      !keyd_acl_word(outer[0], CSSM_ACL_SUBJECT_TYPE_THRESHOLD) ||
      !keyd_acl_word(outer[1], 1) || !keyd_acl_word(outer[2], 2) ||
      outer[3]->ElementType != CSSM_LIST_ELEMENT_SUBLIST ||
      outer[4]->ElementType != CSSM_LIST_ELEMENT_SUBLIST ||
      !keyd_acl_elements(&outer[3]->Element.Sublist, code, 5) ||
      !keyd_acl_word(code[0], CSSM_ACL_SUBJECT_TYPE_CODE_SIGNATURE) ||
      !keyd_acl_word(code[1], CSSM_ACL_CODE_SIGNATURE_OSX) ||
      !keyd_acl_datum(code[2], 20, 20) || !keyd_acl_datum(code[3], 1, 4096) ||
      !keyd_acl_datum(code[4], 1, 65536) ||
      !keyd_acl_requirement(&code[4]->Element.Word, requirement) ||
      !keyd_acl_elements(&outer[4]->Element.Sublist, prompt, 3) ||
      !keyd_acl_word(prompt[0], CSSM_ACL_SUBJECT_TYPE_KEYCHAIN_PROMPT) ||
      !keyd_acl_datum(prompt[1], sizeof(CSSM_ACL_KEYCHAIN_PROMPT_SELECTOR),
                     sizeof(CSSM_ACL_KEYCHAIN_PROMPT_SELECTOR)) ||
      !keyd_acl_datum(prompt[2], 1, 4096)) return 0;
  CSSM_ACL_KEYCHAIN_PROMPT_SELECTOR selector;
  memcpy(&selector, prompt[1]->Element.Word.Data, sizeof(selector));
  return selector.version == CSSM_ACL_KEYCHAIN_PROMPT_CURRENT_VERSION && selector.flags == 0;
}

// SecAccessGetOwnerAndACL returns separately allocated nodes/data. They are copies, not
// references into the Keychain. Release each exactly once, excluding the Tail alias.
static void keyd_acl_free_list(CSSM_LIST *list, unsigned depth) {
  if (!list || depth > 16) return;
  CSSM_LIST_ELEMENT *element = list->Head;
  for (unsigned i = 0; element && i < 4096; i++) {
    CSSM_LIST_ELEMENT *next = element->NextElement;
    if (element->ElementType == CSSM_LIST_ELEMENT_SUBLIST)
      keyd_acl_free_list(&element->Element.Sublist, depth + 1);
    else if (element->ElementType == CSSM_LIST_ELEMENT_DATUM)
      free(element->Element.Word.Data);
    free(element);
    element = next;
  }
}
static OSStatus keyd_acl_policy(SecAccessRef access, const char *requirementText) {
  CSSM_ACL_OWNER_PROTOTYPE *owner = NULL;
  CSSM_ACL_ENTRY_INFO *entries = NULL;
  uint32 count = 0;
  SecRequirementRef requirement = NULL;
  CFDataRef expected = NULL;
  CFStringRef text = CFStringCreateWithCString(NULL, requirementText, kCFStringEncodingUTF8);
  OSStatus status = text ? SecRequirementCreateWithString(text, 0, &requirement) : errSecAllocate;
  if (status == errSecSuccess) status = SecRequirementCopyData(requirement, 0, &expected);
  if (status == errSecSuccess) status = SecAccessGetOwnerAndACL(access, &owner, &count, &entries);
  if (status == errSecSuccess && (!owner || !entries || !count || count > 64)) status = errSecAuthFailed;
  unsigned readable = 0;
  for (uint32 i = 0; status == errSecSuccess && i < count; i++) {
    CSSM_ACL_ENTRY_PROTOTYPE *entry = &entries[i].EntryPublicInfo;
    CSSM_AUTHORIZATIONGROUP tags = entry->Authorization;
    if (tags.NumberOfAuthTags > 64 || (tags.NumberOfAuthTags && !tags.AuthTags)) {
      status = errSecAuthFailed; break;
    }
    // An empty authorization set means ANY in the legacy ACL engine.
    int grantsRead = tags.NumberOfAuthTags == 0;
    for (uint32 j = 0; j < tags.NumberOfAuthTags; j++)
      if (tags.AuthTags[j] == CSSM_ACL_AUTHORIZATION_ANY ||
          tags.AuthTags[j] == CSSM_ACL_AUTHORIZATION_DECRYPT) grantsRead = 1;
    if (!grantsRead) continue;
    readable++;
    if (entry->Delegate || !keyd_acl_subject(&entry->TypedSubject, expected)) status = errSecAuthFailed;
  }
  if (status == errSecSuccess && !readable) status = errSecAuthFailed;
  if (owner) { keyd_acl_free_list(&owner->TypedSubject, 0); free(owner); }
  if (entries) {
    for (uint32 i = 0; i < count; i++) {
      keyd_acl_free_list(&entries[i].EntryPublicInfo.TypedSubject, 0);
      free(entries[i].EntryPublicInfo.Authorization.AuthTags);
    }
    free(entries);
  }
  if (expected) CFRelease(expected);
  if (requirement) CFRelease(requirement);
  if (text) CFRelease(text);
  return status;
}
