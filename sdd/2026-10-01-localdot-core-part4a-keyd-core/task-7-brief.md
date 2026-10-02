### Task 7: The scrubber — real values never flow back into a cell

S4: "postman-echo reflected `real-secret-value-for-spike` into the cell." The spec: "The real
secret is scrubbed from responses in plain, base64, URL-encoded and hex forms." The scrubber
replaces each form of each secret with the same form of the cell's surrogate (or the marker
`keyd-redacted` when the cell holds none, P4a-R18): the plain value, lower and upper hex, and
padded and unpadded standard and URL-safe base64. Each of these forms also matches with any of its
bytes escaped the way an encoder may escape it, byte by byte: percent-encoded in either case (or `+`
for a space), JSON's backslash-u in either case or its short escapes, HTML's named and numeric
references. That covers Go's `json.Marshal` (which escapes `<`, `>` and `&`), .NET's encoder (which
also escapes `+`, `'` and `"`), JavaScript's `encodeURIComponent`, Python's `quote`, PHP's `\/` and
`html.EscapeString`, and any mix of them; a replacement must be made of characters no encoder
escapes, so it fits whichever form it replaces. Escapes of the bytes those encoders leave alone
(letters, digits and `-._~`, so `%7E` from Java's `URLEncoder`), `&#X3C;` with a capital X and
numeric references padded past three digits are not matched (P4a-R18). The backslash-u forms are
built in code rather than written out, because a tool that handled the first draft of this plan
turned every one it saw into the character it stood for, which left the Go escape rule a no-op that
its test could not catch (review 1, I1). Inside a longer base64 value the secret's characters
depend on its byte offset mod 3, so the characters set by the secret's bits alone are matched at all
three offsets and overwritten; that is what destroys a reflected `Basic base64(user:secret)`. As a
stream, it holds back only a tail that could still grow into a match, so an SSE event is never
delayed (a chunk that cannot start a secret passes at once), and an upstream error drops the held
tail rather than release half a secret. Compressed bodies are handled one level up (Task 10): keyd
asks for gzip only and decodes a lone gzip itself, and any other coding, or a second one, is refused
(P4a-R10).

**Files:**
- Create: `keyd/internal/scrub/scrub.go`
- Test: `keyd/internal/scrub/scrub_test.go`

**Interfaces:**
- Produces: `Pair{Secret, Replacement []byte}`, `New(pairs ...Pair) (*Scrubber, error)` (refuses a
  secret shorter than 8 bytes, and a replacement with a character outside A–Z a–z 0–9 `-._~`),
  `(*Scrubber).Bytes([]byte) []byte`, `(*Scrubber).Header(http.Header)`
  (in place), `(*Scrubber).Reader(io.ReadCloser) io.ReadCloser`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/scrub/scrub_test.go`:
```go
package scrub

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

const (
	secret    = "real-secret-value+for/test="
	surrogate = "ld_key_AAAAAAAAAAAAAAAAAAAAAA_AAAAAA"
	// punct holds the characters URL, JSON and HTML encoders escape differently.
	punct = `real<secret>&value+'q"/= \x`
)

func scrubber(t *testing.T) *Scrubber {
	t.Helper()
	s, err := New(Pair{Secret: []byte(secret), Replacement: []byte(surrogate)})
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func b64(enc *base64.Encoding, s string) string { return enc.EncodeToString([]byte(s)) }

func assertClean(t *testing.T, name string, out []byte) {
	t.Helper()
	for _, form := range []string{secret, hex.EncodeToString([]byte(secret)), url.QueryEscape(secret)} {
		if bytes.Contains(out, []byte(form)) {
			t.Fatalf("%s: output still holds %q: %s", name, form, out)
		}
	}
}

func TestEveryEncodingOfTheSecretIsReplaced(t *testing.T) {
	s := scrubber(t)
	cases := map[string][2]string{
		"plain":         {"key=" + secret + ";", "key=" + surrogate + ";"},
		"hex":           {hex.EncodeToString([]byte(secret)), hex.EncodeToString([]byte(surrogate))},
		"HEX":           {strings.ToUpper(hex.EncodeToString([]byte(secret))), strings.ToUpper(hex.EncodeToString([]byte(surrogate)))},
		"query escape":  {"?k=" + url.QueryEscape(secret), "?k=" + url.QueryEscape(surrogate)},
		"path escape":   {"/" + url.PathEscape(secret), "/" + url.PathEscape(surrogate)},
		"lower percent": {strings.NewReplacer("%2B", "%2b", "%2F", "%2f", "%3D", "%3d").Replace(url.QueryEscape(secret)), surrogate},
		"base64 std":    {b64(base64.StdEncoding, secret), b64(base64.StdEncoding, surrogate)},
		"base64 url":    {b64(base64.URLEncoding, secret), b64(base64.URLEncoding, surrogate)},
		"base64 raw":    {b64(base64.RawStdEncoding, secret), b64(base64.RawStdEncoding, surrogate)},
		"json":          {mustJSON(secret), mustJSON(surrogate)},
	}
	for name, c := range cases {
		got := string(s.Bytes([]byte(c[0])))
		if got != c[1] {
			t.Errorf("%s: %q -> %q, want %q", name, c[0], got, c[1])
		}
	}
}

func mustJSON(v string) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// dotnet escapes as .NET's System.Text.Json does by default: the HTML-sensitive characters, + and
// the backtick as upper-case backslash-u, a backslash as two.
func dotnet(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case strings.IndexByte("<>&'\"+`", c) >= 0:
			fmt.Fprintf(&b, `\`+"u%04X", c)
		case c == '\\':
			b.WriteString(`\\`)
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}

// percentEncode escapes every byte but letters, digits and keep, as JavaScript's encodeURIComponent
// (keep -_.!~*'()) and Python's quote (keep _.-~/) do.
func percentEncode(s, keep string, lower bool) string {
	f := "%%%02X"
	if lower {
		f = "%%%02x"
	}
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, f, c)
	}
	return b.String()
}

func TestEscapedReflectionsAreReplaced(t *testing.T) {
	s, err := New(Pair{Secret: []byte(punct), Replacement: []byte(surrogate)})
	if err != nil {
		t.Fatal(err)
	}
	goJSON := mustJSON(punct)
	if !strings.Contains(goJSON, `\`+"u003c") || !strings.Contains(goJSON, `\`+"u0026") {
		t.Fatalf("json.Marshal(%q) = %s: Go escapes < and & no more, so this test checks nothing", punct, goJSON)
	}
	cases := map[string][2]string{
		"Go's json.Marshal":   {goJSON, mustJSON(surrogate)},
		".NET's JSON":         {`"` + dotnet(punct) + `"`, `"` + surrogate + `"`},
		"html.EscapeString":   {"<p>" + html.EscapeString(punct) + "</p>", "<p>" + surrogate + "</p>"},
		"url.QueryEscape":     {"?k=" + url.QueryEscape(punct), "?k=" + surrogate},
		"encodeURIComponent":  {"?k=" + percentEncode(punct, "-_.!~*'()", false), "?k=" + surrogate},
		"Python's quote":      {"/" + percentEncode(punct, "_.-~/", false), "/" + surrogate},
		"lower-case percents": {percentEncode(punct, "", true), surrogate},
	}
	for name, c := range cases {
		if got := string(s.Bytes([]byte(c[0]))); got != c[1] {
			t.Errorf("%s: %q -> %q, want %q", name, c[0], got, c[1])
		}
	}
}

func TestEscapedReflectionsStreamLikeOneShot(t *testing.T) {
	s, _ := New(Pair{Secret: []byte(punct), Replacement: []byte(surrogate)})
	body := "a " + mustJSON(punct) + " b " + html.EscapeString(punct) + " c " + dotnet(punct) + " d " + url.QueryEscape(punct) + "\n"
	want := "a " + mustJSON(surrogate) + " b " + surrogate + " c " + surrogate + " d " + surrogate + "\n"
	if got := string(s.Bytes([]byte(body))); got != want {
		t.Fatalf("one shot: %q, want %q", got, want)
	}
	for split := 1; split < len(body); split++ {
		if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: []string{body[:split], body[split:]}}))); got != want {
			t.Fatalf("split at %d: %q, want %q", split, got, want)
		}
	}
	if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: strings.Split(body, "")}))); got != want {
		t.Fatalf("byte by byte: %q, want %q", got, want)
	}
}

func TestBase64EmbeddedAtAnyOffsetIsDestroyed(t *testing.T) {
	s := scrubber(t)
	for _, prefix := range []string{"", "u", "us", "user:", "ab:", "x:"} {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
			blob := enc.EncodeToString([]byte(prefix + secret + "&tail"))
			out := s.Bytes([]byte("Basic " + blob))
			decoded, _ := enc.DecodeString(strings.TrimPrefix(string(out), "Basic "))
			if bytes.Contains(decoded, []byte(secret)) || bytes.Contains(out, []byte(blob)) {
				t.Errorf("prefix %q: the secret survives in %s", prefix, out)
			}
		}
	}
}

func TestStreamingMatchesOneShotAtEverySplit(t *testing.T) {
	s := scrubber(t)
	body := "{\"echo\":\"" + secret + "\",\"b64\":\"" + b64(base64.StdEncoding, "user:"+secret) + "\",\"hex\":\"" + hex.EncodeToString([]byte(secret)) + "\"}\n"
	want := string(s.Bytes([]byte(body)))
	assertClean(t, "one shot", []byte(want))
	for split := 1; split < len(body); split++ {
		got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: []string{body[:split], body[split:]}})))
		if got != want {
			t.Fatalf("split at %d: %q, want %q", split, got, want)
		}
	}
	rng := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		var parts []string
		for rest := body; rest != ""; {
			n := min(len(rest), 1+rng.IntN(7))
			parts = append(parts, rest[:n])
			rest = rest[n:]
		}
		if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: parts}))); got != want {
			t.Fatalf("parts %q: %q, want %q", parts, got, want)
		}
	}
}

func TestReadNeverReturnsPartOfTheSecret(t *testing.T) {
	s := scrubber(t)
	body := "aaaa" + secret + "bbbb" + secret
	r := s.Reader(io.NopCloser(&chunked{parts: strings.Split(body, "")}))
	var all []byte
	buf := make([]byte, 3)
	for {
		n, err := r.Read(buf)
		all = append(all, buf[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	assertClean(t, "byte by byte", all)
}

func TestAChunkThatCannotStartTheSecretIsNotHeldBack(t *testing.T) {
	s := scrubber(t)
	pr, pw := io.Pipe()
	r := s.Reader(pr)
	go pw.Write([]byte("data: {\"delta\":\"hi\"}\n\n"))
	got := make(chan string, 1)
	go func() {
		buf := make([]byte, 64)
		n, _ := r.Read(buf)
		got <- string(buf[:n])
	}()
	select {
	case g := <-got:
		if g != "data: {\"delta\":\"hi\"}\n\n" {
			t.Fatalf("read %q", g)
		}
	case <-time.After(time.Second):
		t.Fatal("an SSE event was held back waiting for more data")
	}
	pw.Close()
}

func TestAnUpstreamErrorDropsTheHeldBytes(t *testing.T) {
	s := scrubber(t)
	boom := errors.New("upstream reset")
	r := s.Reader(io.NopCloser(&chunked{parts: []string{"ok " + secret[:10]}, err: boom}))
	data, err := io.ReadAll(r)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the upstream error", err)
	}
	if string(data) != "ok " {
		t.Fatalf("data = %q, want only the bytes that cannot be part of the secret", data)
	}
}

func TestHeaderValuesAreScrubbed(t *testing.T) {
	s := scrubber(t)
	h := http.Header{
		"Location":   {"https://cdn.example.test/file?key=" + url.QueryEscape(secret)},
		"Set-Cookie": {"k=" + secret + "; Path=/"},
		"X-Echo":     {secret},
	}
	s.Header(h)
	for k, vs := range h {
		for _, v := range vs {
			assertClean(t, k, []byte(v))
		}
	}
	if h.Get("X-Echo") != surrogate {
		t.Fatalf("X-Echo = %q", h.Get("X-Echo"))
	}
}

func TestNewRefusesShortSecretsAndEmptyIsANoOp(t *testing.T) {
	if _, err := New(Pair{Secret: []byte("short"), Replacement: []byte(surrogate)}); err == nil {
		t.Fatal("New accepted a 5-byte secret")
	}
	if _, err := New(Pair{Secret: []byte(secret), Replacement: []byte("a/b")}); err == nil {
		t.Fatal("New accepted a replacement an encoder would change")
	}
	s, err := New()
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Bytes([]byte(secret)); string(got) != secret {
		t.Fatalf("empty scrubber changed %q", got)
	}
}

func TestCloseClosesTheSource(t *testing.T) {
	src := &closeRecorder{Reader: strings.NewReader("x")}
	if err := scrubber(t).Reader(src).Close(); err != nil || !src.closed {
		t.Fatalf("Close err %v closed %v", err, src.closed)
	}
}

type chunked struct {
	parts []string
	err   error
}

func (c *chunked) Read(p []byte) (int, error) {
	if len(c.parts) == 0 {
		if c.err != nil {
			return 0, c.err
		}
		return 0, io.EOF
	}
	n := copy(p, c.parts[0])
	c.parts[0] = c.parts[0][n:]
	if c.parts[0] == "" {
		c.parts = c.parts[1:]
	}
	return n, nil
}

type closeRecorder struct {
	io.Reader
	closed bool
}

func (c *closeRecorder) Close() error { c.closed = true; return nil }

func readAll(t *testing.T, r io.Reader) string {
	t.Helper()
	b, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/scrub/`
Expected: FAIL — `[build failed]`, starting `internal/scrub/scrub_test.go:27:30: undefined: Scrubber`.

- [ ] **Step 3: Implement the scrubber**

`keyd/internal/scrub/scrub.go`:
```go
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
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/scrub/`
Expected: `ok` (11 tests; the split tests feed every two-chunk split, and the plain one 200 random
chunkings too). `TestEscapedReflectionsAreReplaced` first checks that `json.Marshal` still escapes
`<` and `&`, so the Go case can fail.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/scrub
git commit -m "feat(keyd): streaming response scrubber"
```

---
