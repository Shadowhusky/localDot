#include "keychain_acl_darwin.h"
#include <stdio.h>

static const char *pinned =
  "identifier \"dev.localdot.keyd\" and anchor apple generic and "
  "certificate 1[field.1.2.840.113635.100.6.2.6] exists and "
  "certificate leaf[field.1.2.840.113635.100.6.1.13] exists and "
  "certificate leaf[subject.OU] = \"87FD3FSZBG\" and info [KeydGeneration] >= \"2\"";
static CSSM_LIST_ELEMENT word(unsigned value) {
  CSSM_LIST_ELEMENT e = {0}; e.ElementType = CSSM_LIST_ELEMENT_WORDID; e.WordID = value; return e;
}
static CSSM_LIST_ELEMENT datum(void *data, size_t size) {
  CSSM_LIST_ELEMENT e = {0}; e.ElementType = CSSM_LIST_ELEMENT_DATUM;
  e.Element.Word.Data = data; e.Element.Word.Length = size; return e;
}
static CSSM_LIST list(CSSM_LIST_ELEMENT *elements, size_t count) {
  for (size_t i = 0; i < count; i++) elements[i].NextElement = i + 1 < count ? &elements[i+1] : NULL;
  CSSM_LIST value = {CSSM_LIST_TYPE_UNKNOWN, elements, &elements[count-1]}; return value;
}
static CSSM_LIST_ELEMENT sublist(CSSM_LIST value) {
  CSSM_LIST_ELEMENT e = {0}; e.ElementType = CSSM_LIST_ELEMENT_SUBLIST; e.Element.Sublist = value; return e;
}
static CFDataRef requirement(const char *value) {
  CFStringRef text = CFStringCreateWithCString(NULL, value, kCFStringEncodingUTF8);
  SecRequirementRef ref = NULL; CFDataRef bytes = NULL;
  if (SecRequirementCreateWithString(text, 0, &ref) == 0) SecRequirementCopyData(ref, 0, &bytes);
  if (ref) CFRelease(ref); CFRelease(text); return bytes;
}
int main(void) {
	setbuf(stdout, NULL);
  CFDataRef expected = requirement(pinned), broad = requirement("always");
  if (!expected || !broad) return 1;
  CFMutableDataRef changed = CFDataCreateMutableCopy(NULL, 0, expected);
  if (!changed) return 1;
  CFDataRef generated = requirement("identifier \"dev.localdot.keyd\" and (anchor apple generic and (certificate 1[field.1.2.840.113635.100.6.2.6] exists and (certificate leaf[field.1.2.840.113635.100.6.1.13] exists and (certificate leaf[subject.OU] = \"87FD3FSZBG\" and info [KeydGeneration] >= \"2\"))))");
  CFDataRef weakened = requirement("identifier \"dev.localdot.keyd\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and (certificate leaf[field.1.2.840.113635.100.6.1.13] exists or certificate leaf[subject.OU] = \"87FD3FSZBG\") and info [KeydGeneration] >= \"2\"");
  CFDataRef wrongTeam = requirement("identifier \"dev.localdot.keyd\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"OTHERTEAM1\" and info [KeydGeneration] >= \"2\"");
  CFDataRef earlier = requirement("identifier \"dev.localdot.keyd\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"87FD3FSZBG\"");
  CFDataRef anyGeneration = requirement("identifier \"dev.localdot.keyd\" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"87FD3FSZBG\" and info [KeydGeneration] >= \"1\"");
  if (!generated || !weakened || !wrongTeam || !earlier || !anyGeneration || CFEqual(generated,expected)) return 1;
  unsigned char hash[20] = {0}; char path[] = "/old/release/keyd", title[] = "fake policy";
  CSSM_ACL_KEYCHAIN_PROMPT_SELECTOR selector = {CSSM_ACL_KEYCHAIN_PROMPT_CURRENT_VERSION, 0};
  const char *cases[] = {"pinned", "moved path", "different legacy hash", "wide requirement",
    "missing requirement", "additional signature field", "extra trusted choice", "zero threshold",
    "ANY grant", "wrong signature kind", "unknown prompt", "unknown prompt flags",
    "extra outer element", "cyclic subject", "short legacy hash", "wrong data type",
    "same-size lower requirement bytes", "same-size higher requirement bytes",
    "codesign generated AND grouping", "OR widens certificate requirement", "different team",
    "the earlier keyd's requirement", "an earlier generation"};
  for (unsigned test = 0; test < sizeof(cases)/sizeof(cases[0]); test++) {
    selector.flags = 0;
    CSSM_LIST_ELEMENT code[6] = {word(CSSM_ACL_SUBJECT_TYPE_CODE_SIGNATURE),
      word(CSSM_ACL_CODE_SIGNATURE_OSX), datum(hash,20), datum(path,sizeof(path)),
      datum((void *)CFDataGetBytePtr(expected),CFDataGetLength(expected)), word(0)};
    CSSM_LIST_ELEMENT prompt[] = {word(CSSM_ACL_SUBJECT_TYPE_KEYCHAIN_PROMPT),
      datum(&selector,sizeof(selector)), datum(title,sizeof(title))};
    CSSM_LIST_ELEMENT outer[6] = {word(CSSM_ACL_SUBJECT_TYPE_THRESHOLD),word(1),word(2),
      sublist(list(code,5)),sublist(list(prompt,3)),word(0)};
    CSSM_LIST subject = list(outer,5);
    switch (test) {
      case 1: code[3] = datum("/new/release/keyd",18); code[3].NextElement=&code[4]; break;
      case 2: hash[0] ^= 1; break;
      case 3: code[4] = datum((void *)CFDataGetBytePtr(broad),CFDataGetLength(broad)); break;
      case 4: code[3].NextElement=NULL; outer[3].Element.Sublist.Tail=&code[3]; break;
      case 5: outer[3].Element.Sublist=list(code,6); break;
      case 6: outer[2].WordID=3; break;
      case 7: outer[1].WordID=0; break;
      case 8: code[0].WordID=CSSM_ACL_SUBJECT_TYPE_ANY; break;
      case 9: code[1].WordID=0; break;
      case 10: prompt[0].WordID=CSSM_ACL_SUBJECT_TYPE_ANY; break;
      case 11: selector.flags=0x8000; break;
      case 12: subject=list(outer,6); break;
      case 13: outer[4].NextElement=&outer[0]; break;
      case 14: code[2].Element.Word.Length=19; break;
      case 15: code[4].ElementType=CSSM_LIST_ELEMENT_WORDID; break;
      case 16:
      case 17:
        CFDataGetMutableBytePtr(changed)[0] = CFDataGetBytePtr(expected)[0] + (test == 16 ? -1 : 1);
        code[4]=datum(CFDataGetMutableBytePtr(changed),CFDataGetLength(changed)); break;
      case 18: code[4]=datum((void *)CFDataGetBytePtr(generated),CFDataGetLength(generated)); break;
      case 19: code[4]=datum((void *)CFDataGetBytePtr(weakened),CFDataGetLength(weakened)); break;
      case 20: code[4]=datum((void *)CFDataGetBytePtr(wrongTeam),CFDataGetLength(wrongTeam)); break;
      case 21: code[4]=datum((void *)CFDataGetBytePtr(earlier),CFDataGetLength(earlier)); break;
      case 22: code[4]=datum((void *)CFDataGetBytePtr(anyGeneration),CFDataGetLength(anyGeneration)); break;
    }
    int accepted=keyd_acl_subject(&subject,expected);
    if (accepted != (test<3 || test==18)) { fprintf(stderr,"unexpected policy result: %s\n",cases[test]); return 1; }
    printf("PASS %s\n",cases[test]);
  }
  // Exercise public Security.framework round-trip and allocation cleanup, without any Keychain.
  CSSM_LIST_ELEMENT code[] = {word(CSSM_ACL_SUBJECT_TYPE_CODE_SIGNATURE),word(CSSM_ACL_CODE_SIGNATURE_OSX),
    datum(hash,20),datum(path,sizeof(path)),datum((void *)CFDataGetBytePtr(expected),CFDataGetLength(expected))};
  selector.flags=0;
  CSSM_LIST_ELEMENT prompt[] = {word(CSSM_ACL_SUBJECT_TYPE_KEYCHAIN_PROMPT),datum(&selector,sizeof(selector)),datum(title,sizeof(title))};
  CSSM_LIST_ELEMENT outer[] = {word(CSSM_ACL_SUBJECT_TYPE_THRESHOLD),word(1),word(2),sublist(list(code,5)),sublist(list(prompt,3))};
  CSSM_ACL_AUTHORIZATION_TAG tag = CSSM_ACL_AUTHORIZATION_DECRYPT;
  CSSM_ACL_OWNER_PROTOTYPE owner = {list(prompt,3),0};
  CSSM_ACL_ENTRY_INFO entry = {0};entry.EntryPublicInfo.TypedSubject=list(outer,5);
  entry.EntryPublicInfo.Authorization.NumberOfAuthTags=1;entry.EntryPublicInfo.Authorization.AuthTags=&tag;
  SecAccessRef access=NULL;
  if (SecAccessCreateFromOwnerAndACL(&owner,1,&entry,&access) || keyd_acl_policy(access,pinned)) return 1;
  CFRelease(access); printf("PASS framework policy round-trip\n");
  code[4]=datum((void *)CFDataGetBytePtr(broad),CFDataGetLength(broad));
  if (SecAccessCreateFromOwnerAndACL(&owner,1,&entry,&access) || keyd_acl_policy(access,pinned)==0) return 1;
  CFRelease(access); printf("PASS framework wide requirement refusal\n");
  // A delegated read grant lets its holder pass the grant on, so the pinned subject alone is not enough.
  code[4]=datum((void *)CFDataGetBytePtr(expected),CFDataGetLength(expected));
  entry.EntryPublicInfo.Delegate=CSSM_TRUE;
  if (SecAccessCreateFromOwnerAndACL(&owner,1,&entry,&access) || keyd_acl_policy(access,pinned)==0) return 1;
  CFRelease(access); printf("PASS framework delegated grant refusal\n");
  CFRelease(expected);CFRelease(broad);CFRelease(changed);
  CFRelease(generated);CFRelease(weakened);CFRelease(wrongTeam);CFRelease(earlier);CFRelease(anyGeneration);return 0;
}
