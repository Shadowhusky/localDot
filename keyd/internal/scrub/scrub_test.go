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
