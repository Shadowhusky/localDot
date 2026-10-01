package scrub

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

const (
	// tilde is 26 bytes, so its base64 ends in a partial group, and its standard and URL-safe
	// base64 differ at every byte offset.
	tilde = "real~secret~value~for~test"
	// amp ends in a byte whose escapes start with that byte, so a longer spelling can follow it.
	amp = "real&secret-value&"
	// Backslash escapes are built from bsl, so no tool that handles this file can unescape them.
	bsl = `\`
)

func scrubberOf(t *testing.T, secrets ...string) *Scrubber {
	t.Helper()
	var pairs []Pair
	for _, s := range secrets {
		pairs = append(pairs, Pair{Secret: []byte(s), Replacement: []byte(surrogate)})
	}
	s, err := New(pairs...)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func isUnreserved(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("-._~", c) >= 0
}

func TestEveryEscapedByteMatchesInEverySpelling(t *testing.T) {
	var punct []byte
	for c := byte(0x20); c < 0x7f; c++ {
		if !isUnreserved(c) {
			punct = append(punct, c)
		}
	}
	sec := "real" + string(punct) + "test"
	s := scrubberOf(t, sec)
	u := bsl + "u%04"
	for _, f := range []string{"%%%02X", "%%%02x", u + "X", u + "x", "&#%d;", "&#%03d;", "&#x%X;", "&#x%x;"} {
		var in strings.Builder
		for _, c := range []byte(sec) {
			if isUnreserved(c) {
				in.WriteByte(c)
			} else {
				fmt.Fprintf(&in, f, c)
			}
		}
		if got := string(s.Bytes([]byte(in.String()))); got != surrogate {
			t.Errorf("every byte as %s: %q -> %q", f, in.String(), got)
		}
	}
}

func TestPHPPythonAndTemplateEscapesAreReplaced(t *testing.T) {
	s := scrubberOf(t, punct)
	esc := func(pairs ...string) func(string) string { return strings.NewReplacer(pairs...).Replace }
	cases := map[string]string{
		"PHP json_encode":                 esc(bsl, bsl+bsl, `"`, bsl+`"`, "/", bsl+"/")(punct),
		"PHP htmlspecialchars ENT_QUOTES": esc("&", "&amp;", `"`, "&quot;", "'", "&#039;", "<", "&lt;", ">", "&gt;")(punct),
		"PHP ENT_QUOTES | ENT_HTML5":      esc("&", "&amp;", `"`, "&quot;", "'", "&apos;", "<", "&lt;", ">", "&gt;")(punct),
		"Python html.escape":              esc("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;")(punct),
		"Handlebars":                      esc("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#x27;", "`", "&#x60;", "=", "&#x3D;")(punct),
	}
	for name, in := range cases {
		if got := string(s.Bytes([]byte(in))); got != surrogate {
			t.Errorf("%s: %q -> %q", name, in, got)
		}
	}
}

func TestASecretOpeningWithAnEscapedByteIsReplaced(t *testing.T) {
	// A key drawn from base64 can begin with + or /.
	for _, sec := range []string{"/real-secret-value", "+real-secret-value", "=real-secret-value"} {
		s := scrubberOf(t, sec)
		for _, in := range []string{
			url.QueryEscape(sec),
			strings.ToLower(url.QueryEscape(sec)),
			dotnet(sec),
			strings.Replace(sec, "/", bsl+"/", 1),
			fmt.Sprintf("&#x%X;", sec[0]) + sec[1:],
			fmt.Sprintf("&#%d;", sec[0]) + sec[1:],
		} {
			if got := string(s.Bytes([]byte(in))); got != surrogate {
				t.Errorf("%q: %q -> %q", sec, in, got)
			}
		}
	}
}

func TestEveryValueOfAHeaderIsScrubbed(t *testing.T) {
	s := scrubber(t)
	h := http.Header{
		"Set-Cookie": {"a=1; Path=/", "k=" + url.QueryEscape(secret) + "; Path=/"},
		"X-Echo":     {"ok", secret, b64(base64.StdEncoding, secret)},
	}
	s.Header(h)
	want := http.Header{
		"Set-Cookie": {"a=1; Path=/", "k=" + surrogate + "; Path=/"},
		"X-Echo":     {"ok", surrogate, b64(base64.StdEncoding, surrogate)},
	}
	if !reflect.DeepEqual(h, want) {
		t.Fatalf("headers %v, want %v", h, want)
	}
}

func TestBase64OfASecretEndingInAPartialGroup(t *testing.T) {
	if len(tilde)%3 == 0 {
		t.Fatal("tilde must not fill its last base64 group")
	}
	s := scrubberOf(t, tilde)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding, base64.RawStdEncoding, base64.RawURLEncoding} {
		if got, want := string(s.Bytes([]byte(b64(enc, tilde)))), b64(enc, surrogate); got != want {
			t.Errorf("%q -> %q, want %q", b64(enc, tilde), got, want)
		}
	}
}

// coreOf is the run of base64 characters set by the secret's bits alone when it starts k bytes into
// a longer value.
func coreOf(enc *base64.Encoding, k int, secret string) string {
	e := enc.EncodeToString(append(make([]byte, k), secret...))
	return e[(4*k+2)/3 : 4*(k+len(secret))/3]
}

func TestBase64CoresOfBothAlphabetsAreDestroyed(t *testing.T) {
	alphabets := []*base64.Encoding{base64.RawStdEncoding, base64.RawURLEncoding}
	for k := range 3 {
		if coreOf(alphabets[0], k, tilde) == coreOf(alphabets[1], k, tilde) {
			t.Fatalf("offset %d: both alphabets agree, so this checks only one of them", k)
		}
	}
	s := scrubberOf(t, tilde)
	// The top two bits of x are not both zero, so the unpadded form of the secret cannot match here.
	for _, prefix := range []string{"", "u", "us", "user:"} {
		for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.URLEncoding} {
			out := s.Bytes([]byte("Basic " + b64(enc, prefix+tilde+"xtail")))
			for k := range 3 {
				for _, a := range alphabets {
					if core := coreOf(a, k, tilde); bytes.Contains(out, []byte(core)) {
						t.Errorf("prefix %q: %s still holds %s", prefix, out, core)
					}
				}
			}
		}
	}
}

func TestTheShortestSecretIsEightBytes(t *testing.T) {
	if _, err := New(Pair{Secret: []byte("12345678"), Replacement: []byte(surrogate)}); err != nil {
		t.Fatalf("New refused an 8-byte secret, which the vault accepts: %v", err)
	}
	if _, err := New(Pair{Secret: []byte("1234567"), Replacement: []byte(surrogate)}); err == nil {
		t.Fatal("New accepted a 7-byte secret")
	}
}

func TestAFormThatCouldStillGrowIsReplacedAtEOF(t *testing.T) {
	s := scrubberOf(t, tilde, amp)
	cases := map[string]string{
		"x " + b64(base64.RawStdEncoding, tilde): "x " + b64(base64.RawStdEncoding, surrogate),
		"x " + amp:                               "x " + surrogate,
	}
	for body, want := range cases {
		for split := 1; split <= len(body); split++ {
			if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: []string{body[:split], body[split:]}}))); got != want {
				t.Fatalf("%q split at %d: %q, want %q", body, split, got, want)
			}
		}
	}
}

func TestStreamingMatchesOneShotWhenALongerSpellingCouldFollow(t *testing.T) {
	// The first secret is a prefix of the second, and its needles come first.
	s := scrubberOf(t, "real-secret-value", "real-secret-value-for-test", tilde, amp)
	body := html.EscapeString(amp) + " " + b64(base64.StdEncoding, tilde) + " " + b64(base64.RawURLEncoding, tilde) + " " + amp + " real-secret-value-for-test\n"
	want := surrogate + " " + b64(base64.StdEncoding, surrogate) + " " + b64(base64.RawURLEncoding, surrogate) + " " + surrogate + " " + surrogate + "\n"
	if got := string(s.Bytes([]byte(body))); got != want {
		t.Fatalf("one shot: %q, want %q", got, want)
	}
	for split := 1; split < len(body); split++ {
		if got := readAll(t, s.Reader(io.NopCloser(&chunked{parts: []string{body[:split], body[split:]}}))); got != want {
			t.Fatalf("split at %d: %q, want %q", split, got, want)
		}
	}
}
