package surrogate

import (
	"regexp"
	"strings"
	"testing"
)

var shape = regexp.MustCompile(`^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$`)

func TestMintShapeAndChecksum(t *testing.T) {
	tok, err := Mint("ant")
	if err != nil {
		t.Fatal(err)
	}
	if !shape.MatchString(tok) {
		t.Fatalf("token %q does not have the surrogate shape", tok)
	}
	if !strings.HasPrefix(tok, "ld_ant_") {
		t.Fatalf("token %q lacks its tag", tok)
	}
	if !Valid(tok) {
		t.Fatalf("minted token %q is not valid", tok)
	}
}

func TestMintRejectsBadTags(t *testing.T) {
	for _, tag := range []string{"", "a", "ANT", "an_t", "abcdefghijklm", "an-t"} {
		if _, err := Mint(tag); err == nil {
			t.Errorf("Mint(%q) succeeded, want an error", tag)
		}
	}
}

func TestMintIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 2000 {
		tok, err := Mint("key")
		if err != nil {
			t.Fatal(err)
		}
		if seen[tok] {
			t.Fatalf("duplicate token %q", tok)
		}
		seen[tok] = true
	}
}

func TestValidRejectsTampering(t *testing.T) {
	tok, _ := Mint("oai")
	body := []byte(tok)
	i := len("ld_oai_") + 3
	if body[i] == 'a' {
		body[i] = 'b'
	} else {
		body[i] = 'a'
	}
	if Valid(string(body)) {
		t.Fatalf("tampered token %q still validates", body)
	}
	for _, s := range []string{"", "ld_oai_short_abcdef", tok + "x", " " + tok} {
		if Valid(s) {
			t.Errorf("Valid(%q) = true", s)
		}
	}
}

func TestFindLocatesTokensInText(t *testing.T) {
	a, _ := Mint("ant")
	b, _ := Mint("key")
	text := "Bearer " + a + ", x-key=" + b + "&q=1 \"" + a + "\""
	got := Find(text)
	want := []string{a, b, a}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("Find = %v, want %v", got, want)
	}
}

func TestFindReportsShapeEvenWithBadChecksum(t *testing.T) {
	forged := "ld_key_" + strings.Repeat("A", 22) + "_AAAAAA"
	if Valid(forged) {
		t.Fatal("forged token validates")
	}
	if got := Find("token=" + forged); len(got) != 1 || got[0] != forged {
		t.Fatalf("Find = %v, want the forged token", got)
	}
}

func TestFindSeesTokensGluedToOtherCharacters(t *testing.T) {
	tok, _ := Mint("ant")
	for _, s := range []string{"x" + tok, tok + "x", tok + "_x", "0" + tok, "Bearer " + tok + "x y"} {
		if got := Find(s); len(got) != 1 || got[0] != tok {
			t.Errorf("Find(%q) = %v, want the token", s, got)
		}
	}
	if got := Find("old_value_x ld_ant_short_abcdef"); len(got) != 0 {
		t.Errorf("Find found %v in text without a token", got)
	}
}

func TestFindReportsOverlappingTokens(t *testing.T) {
	tok, _ := Mint("ant")
	long, _ := Mint("abcdef")
	checksumShort := "ld_xx_" + strings.Repeat("A", 22) + "_AAAA"
	bodyShort := "ld_xx_" + strings.Repeat("A", 20)
	cases := []struct{ text, shadow, hidden string }{
		{checksumShort + tok, checksumShort + "ld", tok},
		{checksumShort + "A" + tok, checksumShort + "Al", tok},
		{bodyShort + long, bodyShort + "ld_abcdef", long},
	}
	for _, c := range cases {
		if got := Find(c.text); len(got) != 2 || got[0] != c.shadow || got[1] != c.hidden {
			t.Errorf("Find(%q) = %v, want %v", c.text, got, []string{c.shadow, c.hidden})
		}
	}
}

func TestIDIsStableAndHidesTheToken(t *testing.T) {
	tok, _ := Mint("gem")
	id := ID(tok)
	if id != ID(tok) {
		t.Fatal("ID is not stable")
	}
	if len(id) != 12 || strings.Contains(tok, id) {
		t.Fatalf("ID(%q) = %q, want 12 hex chars not taken from the token", tok, id)
	}
	other, _ := Mint("gem")
	if ID(other) == id {
		t.Fatal("two tokens share an ID")
	}
}
