// Package scrub removes real secrets from what keyd sends back into a cell: the plain value and its
// hex and base64 forms, in headers and in streamed bodies, where a value may arrive split across
// reads. Each form also matches with any of its bytes escaped as URL, JSON or HTML encoders escape
// them, byte by byte, so an echo from any encoder, or a mix of them, is caught.
package scrub

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
)

const (
	minSecret = 8
	minCore   = 8
)

// Pair is a secret and what replaces it: the cell's surrogate, or a marker when it has none.
type Pair struct {
	Secret      []byte
	Replacement []byte
}

type needle struct {
	find, repl []byte
}

type Scrubber struct {
	needles []needle
	first   [256]bool
}

func New(pairs ...Pair) (*Scrubber, error) {
	s := &Scrubber{}
	seen := map[string]bool{}
	for _, p := range pairs {
		if len(p.Secret) < minSecret {
			return nil, fmt.Errorf("scrub: a secret shorter than %d bytes would match too much", minSecret)
		}
		if slices.ContainsFunc(p.Replacement, func(b byte) bool { return !unreserved(b) }) {
			return nil, errors.New("scrub: a replacement must be letters, digits and -._~, which no encoder escapes")
		}
		for _, n := range forms(p.Secret, p.Replacement) {
			if len(n.find) == 0 || seen[string(n.find)] {
				continue
			}
			seen[string(n.find)] = true
			s.needles = append(s.needles, n)
			s.first[n.find[0]] = true
			for _, alt := range escapes[n.find[0]] {
				s.first[alt[0]] = true
			}
		}
	}
	return s, nil
}

// Bytes scrubs a complete value.
func (s *Scrubber) Bytes(b []byte) []byte {
	out, _ := s.scan(b, true)
	return out
}

// Header scrubs every value in place.
func (s *Scrubber) Header(h http.Header) {
	for _, vs := range h {
		for i, v := range vs {
			vs[i] = string(s.Bytes([]byte(v)))
		}
	}
}

// Reader scrubs a stream. It holds back only a tail that could still grow into a match, so a
// chunk that cannot start a secret is passed on at once. An error other than EOF drops the held
// tail rather than release part of a secret.
func (s *Scrubber) Reader(src io.ReadCloser) io.ReadCloser {
	return &reader{src: src, s: s, buf: make([]byte, 32*1024)}
}

// scan replaces every complete match in data. Unless final, it stops before a position where a
// match could still complete with more data, and reports how much it consumed.
func (s *Scrubber) scan(data []byte, final bool) ([]byte, int) {
	if len(s.needles) == 0 {
		return append([]byte(nil), data...), len(data)
	}
	out := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		if !s.first[data[i]] {
			j := i + 1
			for j < len(data) && !s.first[data[j]] {
				j++
			}
			out = append(out, data[i:j]...)
			i = j
			continue
		}
		best, repl := 0, []byte(nil)
		for _, n := range s.needles {
			end, more := match(n.find, data[i:])
			if more && !final {
				return out, i
			}
			if end > best {
				best, repl = end, n.repl
			}
		}
		if best > 0 {
			out = append(out, repl...)
			i += best
			continue
		}
		out = append(out, data[i])
		i++
	}
	return out, i
}

// match returns the length of the longest start of data that spells find, each byte as itself or
// as one of its escapes (0 when none does), and whether data ran out where a spelling could go on.
func match(find, data []byte) (int, bool) {
	at := []int{0}
	more := false
	for _, b := range find {
		var next []int
		for _, p := range at {
			rest := data[p:]
			if len(rest) == 0 {
				more = true
				continue
			}
			if rest[0] == b {
				next = appendNew(next, p+1)
			}
			for _, alt := range escapes[b] {
				switch {
				case len(rest) >= len(alt):
					if string(rest[:len(alt)]) == alt {
						next = appendNew(next, p+len(alt))
					}
				case string(rest) == alt[:len(rest)]:
					more = true
				}
			}
		}
		if len(next) == 0 {
			return 0, more
		}
		at = next
	}
	return slices.Max(at), more
}

func appendNew(s []int, v int) []int {
	if slices.Contains(s, v) {
		return s
	}
	return append(s, v)
}

type reader struct {
	src     io.ReadCloser
	s       *Scrubber
	buf     []byte
	pending []byte
	out     []byte
	err     error
}

func (r *reader) Read(p []byte) (int, error) {
	for len(r.out) == 0 {
		if r.err != nil {
			if r.err == io.EOF && len(r.pending) > 0 {
				r.out, _ = r.s.scan(r.pending, true)
				r.pending = nil
				break
			}
			r.pending = nil
			return 0, r.err
		}
		n, err := r.src.Read(r.buf)
		r.err = err
		r.pending = append(r.pending, r.buf[:n]...)
		out, consumed := r.s.scan(r.pending, false)
		r.pending = append([]byte(nil), r.pending[consumed:]...)
		r.out = out
	}
	n := copy(p, r.out)
	r.out = r.out[n:]
	return n, nil
}

func (r *reader) Close() error { return r.src.Close() }

func forms(secret, repl []byte) []needle {
	var out []needle
	add := func(find, rep string) { out = append(out, needle{[]byte(find), []byte(rep)}) }
	add(string(secret), string(repl))
	add(hex.EncodeToString(secret), hex.EncodeToString(repl))
	add(strings.ToUpper(hex.EncodeToString(secret)), strings.ToUpper(hex.EncodeToString(repl)))
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.RawURLEncoding} {
		add(enc.EncodeToString(secret), enc.EncodeToString(repl))
	}
	// Inside a longer base64 value the secret's characters depend on its byte offset mod 3; the
	// characters set by the secret's bits alone are the same wherever it sits.
	for _, enc := range []*base64.Encoding{base64.RawStdEncoding, base64.RawURLEncoding} {
		for k := range 3 {
			e := enc.EncodeToString(append(make([]byte, k), secret...))
			core := e[(4*k+2)/3 : 4*(k+len(secret))/3]
			if len(core) >= minCore {
				add(core, strings.Repeat("A", len(core)))
			}
		}
	}
	return out
}

// escapes lists, for each printable byte outside A-Z a-z 0-9 and -._~, the spellings encoders give
// it: percent-encoding in either case (and + for a space), JSON's backslash-u in either case and
// its short escapes, and HTML's named and numeric references. The backslash-u spellings are built
// here rather than written out, so nothing that handles this file can unescape them.
var escapes = func() (t [256][]string) {
	named := map[byte][]string{
		' ': {"+"}, '"': {`\"`, "&quot;"}, '&': {"&amp;"}, '\'': {"&apos;"}, '/': {`\/`},
		'<': {"&lt;"}, '>': {"&gt;"}, '\\': {`\\`},
	}
	for b := byte(0x20); b < 0x7f; b++ {
		if unreserved(b) {
			continue
		}
		alts := slices.Clone(named[b])
		for _, f := range []string{"%%%02X", "%%%02x", `\` + "u%04X", `\` + "u%04x", "&#%d;", "&#%03d;", "&#x%X;", "&#x%x;"} {
			alts = append(alts, fmt.Sprintf(f, b))
		}
		slices.Sort(alts)
		t[b] = slices.Compact(alts)
	}
	return t
}()

func unreserved(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '-' || b == '.' || b == '_' || b == '~'
}
