package surrogate

import (
	"math/rand/v2"
	"regexp"
	"slices"
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

func TestMintAcceptsTheShortestAndLongestTags(t *testing.T) {
	for _, tag := range []string{"ab", "09", "abcdefghijkl", "a1b2c3d4e5f6"} {
		tok, err := Mint(tag)
		if err != nil {
			t.Fatalf("Mint(%q): %v", tag, err)
		}
		if !Valid(tok) || !strings.HasPrefix(tok, "ld_"+tag+"_") {
			t.Fatalf("Mint(%q) = %q", tag, tok)
		}
		if got := Find("x" + tok + "y"); len(got) != 1 || got[0] != tok {
			t.Errorf("Find misses a token with the %d-character tag %q: %v", len(tag), tag, got)
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

func TestFindAndFindIndexMatchABruteForceSearch(t *testing.T) {
	var pool []string
	for _, tag := range []string{"ab", "ld", "key", "abcdef", "abcdefghijkl"} {
		for range 4 {
			tok, err := Mint(tag)
			if err != nil {
				t.Fatal(err)
			}
			pool = append(pool, tok)
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	run := func(chars string, n int) string {
		b := make([]byte, n)
		for i := range b {
			b[i] = chars[rng.IntN(len(chars))]
		}
		return string(b)
	}
	piece := func() string {
		tok := pool[rng.IntN(len(pool))]
		sep := strings.LastIndexByte(tok[:len(tok)-checksumLen-1], '_')
		switch rng.IntN(9) {
		case 0, 1:
			return tok
		case 2: // a checksum one or two short, completed by a following token's "l" or "ld"
			return tok[:len(tok)-1-rng.IntN(2)]
		case 3: // a body two short, completed by a following "ld_" and 6-character tag
			return tok[:sep+1+randomLen-2]
		case 4:
			return tok[rng.IntN(len(tok)):]
		case 5:
			return tok[:rng.IntN(len(tok))]
		case 6:
			return []string{"l", "ld", "ld_", "d_", "_"}[rng.IntN(5)]
		case 7:
			return run(alphabet, rng.IntN(24))
		default:
			return run(" /=:.-x", 1)
		}
	}
	overlaps := map[int]int{}
	for range 2000 {
		var text string
		for range 1 + rng.IntN(5) {
			text += piece()
		}
		var want [][2]int
		var wantText []string
		for i := range len(text) {
			for j := i + 1; j <= len(text); j++ {
				if shape.MatchString(text[i:j]) {
					want = append(want, [2]int{i, j})
					wantText = append(wantText, text[i:j])
				}
			}
		}
		if got := FindIndex(text); !slices.Equal(got, want) {
			t.Fatalf("FindIndex(%q) = %v, want %v", text, got, want)
		}
		if got := Find(text); !slices.Equal(got, wantText) {
			t.Fatalf("Find(%q) = %q, want %q", text, got, wantText)
		}
		for k := 1; k < len(want); k++ {
			if n := want[k-1][1] - want[k][0]; n > 0 {
				overlaps[n]++
			}
		}
	}
	// A token overlaps the next on its last "l" or "ld", or on nine bytes when its body ends in
	// "ld" and its checksum is the next token's 6-character tag.
	for _, n := range []int{1, 2, 9} {
		if overlaps[n] < 10 {
			t.Errorf("%d overlaps of %d bytes in the corpus, want at least 10: %v", overlaps[n], n, overlaps)
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

// Taking random bytes mod 62 without rejection makes the first eight characters a quarter more
// likely than the rest. Over 440,000 characters the two groups' means lie within a few percent of
// each other when the alphabet is uniform, and a quarter apart when it is not.
func TestMintedCharactersAreUniform(t *testing.T) {
	counts := map[byte]int{}
	for range 20000 {
		token, err := Mint("key")
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range []byte(token[len("ld_key_") : len("ld_key_")+randomLen]) {
			counts[c]++
		}
	}
	var low, rest float64
	for i := range len(alphabet) {
		if i < 8 {
			low += float64(counts[alphabet[i]]) / 8
		} else {
			rest += float64(counts[alphabet[i]]) / float64(len(alphabet)-8)
		}
	}
	if ratio := low / rest; ratio > 1.1 || ratio < 0.9 {
		t.Fatalf("the first eight characters appear %.3f times as often as the rest", ratio)
	}
}
