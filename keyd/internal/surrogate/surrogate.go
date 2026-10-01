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
	"strings"
)

const (
	alphabet    = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	randomLen   = 22
	checksumLen = 6
)

var (
	tagPattern   = regexp.MustCompile(`^[a-z0-9]{2,12}$`)
	leadingToken = regexp.MustCompile(`^ld_[a-z0-9]{2,12}_[0-9A-Za-z]{22}_[0-9A-Za-z]{6}`)
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

// Find returns every token-shaped substring of s, checksum or not, including those glued to other
// characters or overlapping each other: a surrogate made part of a longer word is still a misplaced
// surrogate, and a token-shaped run ending on a token's leading "ld" must not hide that token.
// Results are ordered by start offset; no two can share one, as a tag ends at its first underscore
// and every other part has a fixed length.
func Find(s string) []string {
	var found []string
	for i := 0; i < len(s); i++ {
		next := strings.Index(s[i:], "ld_")
		if next < 0 {
			break
		}
		i += next
		if tok := leadingToken.FindString(s[i:]); tok != "" {
			found = append(found, tok)
		}
	}
	return found
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
