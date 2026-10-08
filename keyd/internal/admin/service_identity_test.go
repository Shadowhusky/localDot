package admin

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestServiceIdentityParsing(t *testing.T) {
	valid := ServiceIdentity{OwnerID: strings.Repeat("e", 32), Release: ReleaseIdentity{
		Version: "1.2.3-rc.1", PackageSHA256: strings.Repeat("a", 64), ManifestSHA256: strings.Repeat("b", 64),
	}}
	raw, _ := json.Marshal(valid)
	got, err := ParseServiceIdentity(string(raw))
	if err != nil || *got != valid {
		t.Fatalf("identity roundtrip: %v %v", got, err)
	}
	bad := []string{"", "null", "[]", "{}", string(raw) + "{}", strings.Repeat(" ", 1025),
		strings.Replace(string(raw), `"ownerId"`, `"foreign"`, 1),
		strings.Replace(string(raw), "1.2.3-rc.1", "01.2.3", 1),
		strings.Replace(string(raw), "1.2.3-rc.1", "1.2.3-preview.1", 1),
		strings.Replace(string(raw), strings.Repeat("a", 64), strings.Repeat("A", 64), 1),
		strings.Replace(string(raw), strings.Repeat("e", 32), strings.Repeat("e", 31), 1),
		strings.Replace(string(raw), `"version"`, `"extra":true,"version"`, 1),
	}
	for _, input := range bad {
		if value, err := ParseServiceIdentity(input); err == nil || value != nil || err.Error() != "invalid installed service identity" {
			t.Fatalf("accepted malformed identity or leaked input: %v %v", value, err)
		}
	}
}
