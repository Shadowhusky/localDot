### Task 1: The worktree, the Go module, the surrogate format and the CI job

A surrogate is the only thing a cell holds in place of a key, so its format comes first:
`ld_<tag>_<22 base62 characters>_<6 base62 characters>`, 131 random bits and a CRC32 checksum, the
shape the spec and the research (§3.4) give. `Find` must see a token wherever it sits in a header or
URL, even glued to other characters, because a surrogate made part of a longer word is still a
misplaced one (Review Focus 2).

**Files:**
- Create: `keyd/go.mod`, `keyd/internal/surrogate/surrogate.go`
- Modify: `.github/workflows/ci.yml` (append the `keyd` job), `.gitignore` (one line)
- Test: `keyd/internal/surrogate/surrogate_test.go`

**Interfaces:**
- Produces: package `github.com/shadowhusky/localdot/keyd/internal/surrogate` with
  `Mint(tag string) (string, error)` (tag `^[a-z0-9]{2,12}$`), `Valid(s string) bool` (exact shape
  and checksum), `Find(s string) []string` (every token-shaped substring, checksum or not, in
  order), `ID(token string) string` (12 lowercase hex characters of SHA-256).

- [ ] **Step 1: Create the worktree and the module**

```bash
git -C "/Volumes/Husky's SSD 4T/Projects/localdot" worktree add -b feat/core-part4a "/Volumes/Husky's SSD 4T/Projects/localdot-keyd" main
cd "/Volumes/Husky's SSD 4T/Projects/localdot-keyd" && git branch --show-current && go version
```
Expected: `feat/core-part4a` and `go version go1.27.1 darwin/arm64`.

`keyd/go.mod`:
```text
module github.com/shadowhusky/localdot/keyd

go 1.27

toolchain go1.27.1
```

- [ ] **Step 2: Write the failing tests**

`keyd/internal/surrogate/surrogate_test.go`:
```go
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
```

- [ ] **Step 3: Run them to see them fail**

Run: `cd "/Volumes/Husky's SSD 4T/Projects/localdot-keyd/keyd" && go test ./internal/surrogate/`
Expected: FAIL — `[build failed]`, starting `internal/surrogate/surrogate_test.go:12:14: undefined: Mint`.

- [ ] **Step 4: Implement the format**

`keyd/internal/surrogate/surrogate.go`:
```go
// Package surrogate mints and recognises keyd's surrogate tokens,
// ld_<tag>_<22 base62 random characters>_<6 base62 checksum characters>.
package surrogate

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash/crc32"
	"regexp"
)

const (
	alphabet    = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	randomLen   = 22
	checksumLen = 6
)

var (
	tagPattern   = regexp.MustCompile(`^[a-z0-9]{2,12}$`)
	tokenPattern = regexp.MustCompile(`ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}`)
	exactPattern = regexp.MustCompile(`^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}$`)
)

// Mint returns a fresh token carrying 131 bits of randomness.
func Mint(tag string) (string, error) {
	if !tagPattern.MatchString(tag) {
		return "", fmt.Errorf("surrogate tag %q: want 2-12 lowercase letters or digits", tag)
	}
	random := make([]byte, 0, randomLen)
	var buf [32]byte
	for len(random) < randomLen {
		if _, err := rand.Read(buf[:]); err != nil {
			return "", err
		}
		for _, b := range buf {
			// 248 = 4 * 62: rejecting the rest keeps every character equally likely.
			if b < 248 && len(random) < randomLen {
				random = append(random, alphabet[b%62])
			}
		}
	}
	body := "ld_" + tag + "_" + string(random)
	return body + "_" + checksum(body), nil
}

// Valid reports whether s is exactly one token with a correct checksum.
func Valid(s string) bool {
	if !exactPattern.MatchString(s) {
		return false
	}
	cut := len(s) - checksumLen - 1
	return checksum(s[:cut]) == s[cut+1:]
}

// Find returns every token-shaped string in s, checksum or not, in order, even when it is glued
// to other characters: a surrogate made part of a longer word is still a misplaced surrogate.
func Find(s string) []string {
	return tokenPattern.FindAllString(s, -1)
}

// ID names a token in logs without revealing it.
func ID(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:6])
}

func checksum(body string) string {
	n := crc32.ChecksumIEEE([]byte(body))
	out := make([]byte, checksumLen)
	for i := checksumLen - 1; i >= 0; i-- {
		out[i] = alphabet[n%62]
		n /= 62
	}
	return string(out)
}
```

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/surrogate/`
Expected: `ok  github.com/shadowhusky/localdot/keyd/internal/surrogate` (8 tests).

- [ ] **Step 6: The CI job and the ignore line**

Append to `.github/workflows/ci.yml`, after the `check` job (same indentation as `check:`):
```yaml
  keyd:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: keyd
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: keyd/go.mod
          cache: false
      - run: test -z "$(gofmt -l .)"
      - run: go vet ./...
      - run: GOOS=darwin go vet ./...
      - run: go test -race ./...
```
keyd's tests use fakes for everything macOS-specific (the opt-in Keychain test skips elsewhere),
so they run on the Linux runner; `GOOS=darwin go vet` type-checks the macOS build. The job needs no
dependency cache: the module has three small dependencies.

Append to `.gitignore`:
```
keyd/bin/
```

- [ ] **Step 7: Format, vet, commit**

```bash
cd "/Volumes/Husky's SSD 4T/Projects/localdot-keyd/keyd" && test -z "$(gofmt -l .)" && go vet ./...
cd .. && git add keyd/go.mod keyd/internal/surrogate .github/workflows/ci.yml .gitignore
git commit -m "feat(keyd): Go module, surrogate token format and the CI job"
```

---
