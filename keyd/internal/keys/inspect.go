package keys

import (
	"encoding/base64"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

const (
	ReasonUnknownSurrogate   = "unknown-surrogate"
	ReasonMisplacedSurrogate = "misplaced-surrogate"
	ReasonSurrogatePolicy    = "surrogate-policy"
)

// Dest is where a request goes: Scheme "https" for a host keyd terminates, "http" for a plain
// request, "gateway" for an LLM route.
type Dest struct {
	Cell   string
	Scheme string
	Host   string
	Route  string
}

type Verdict struct {
	Allow       bool
	Reason      string
	Swaps       []Entry
	SecretID    string
	SurrogateID string
}

type occurrence struct {
	token  string
	header string
	basic  bool
}

// Inspect finds every surrogate-shaped token in the request line, its host, user information and
// opaque form included, and the headers. Each must be a surrogate of this cell, bound to this
// destination, appear exactly once, and sit exactly in its bound header in its bound format;
// otherwise the request is refused.
func (r *Registry) Inspect(d Dest, method string, u *url.URL, h http.Header) Verdict {
	occ := scan(u, h)
	var v Verdict
	for _, token := range order(occ) {
		e, ok := r.Lookup(token)
		if !ok {
			return Verdict{Reason: ReasonUnknownSurrogate, SurrogateID: surrogate.ID(token)}
		}
		deny := func(reason string) Verdict {
			return Verdict{Reason: reason, SecretID: e.Binding.SecretID, SurrogateID: e.ID}
		}
		if e.Cell != d.Cell || !bound(e.Binding, d) || !placed(e, occ, h) {
			return deny(ReasonMisplacedSurrogate)
		}
		if e.Binding.Route == "" && !permitted(e.Binding, method, u, h) {
			return deny(ReasonSurrogatePolicy)
		}
		v.Swaps = append(v.Swaps, e)
		if v.SurrogateID == "" {
			v.SecretID, v.SurrogateID = e.Binding.SecretID, e.ID
		}
	}
	v.Allow = true
	return v
}

// permitted applies an HTTP binding's method and path limits. A limited binding matches only a path
// every server reads the same way: decoded, clean (one trailing slash allowed), printable ASCII,
// without ;, ?, # or a backslash, with no segment that starts with two dots, and with no encoded
// dot, slash, backslash, percent or NUL in the raw path, as sent or as re-escaped. A method limit
// also refuses the headers and the _method parameter that make a server treat a request as another
// method.
func permitted(b Binding, method string, u *url.URL, h http.Header) bool {
	if len(b.Paths) > 0 && !unambiguousPath(u) {
		return false
	}
	if len(b.Methods) > 0 && overridesMethod(u, h) {
		return false
	}
	return b.Permits(method, u.Path)
}

var ambiguousEscapes = []string{"%2e", "%2f", "%5c", "%25", "%00"}

func unambiguousPath(u *url.URL) bool {
	raw := strings.ToLower(u.RawPath + " " + u.EscapedPath())
	if slices.ContainsFunc(ambiguousEscapes, func(e string) bool { return strings.Contains(raw, e) }) {
		return false
	}
	p := u.Path
	if !strings.HasPrefix(p, "/") || !printable(p) || strings.ContainsAny(p, `;\?#`) || strings.Contains(p, "/..") {
		return false
	}
	clean := path.Clean(p)
	return p == clean || clean != "/" && p == clean+"/"
}

var overrideHeaders = []string{"X-Http-Method-Override", "X-Http-Method", "X-Method-Override"}

func overridesMethod(u *url.URL, h http.Header) bool {
	if slices.ContainsFunc(overrideHeaders, func(name string) bool { return len(h.Values(name)) > 0 }) {
		return true
	}
	for _, pair := range strings.FieldsFunc(u.RawQuery, func(r rune) bool { return r == '&' || r == ';' }) {
		key, _, _ := strings.Cut(pair, "=")
		if strings.EqualFold(unescape(key), "_method") {
			return true
		}
	}
	return false
}

// unescape decodes every valid %XX and leaves anything else as it is, so one bad escape cannot
// hide the rest of a query.
func unescape(s string) string {
	if !strings.Contains(s, "%") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				b.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func bound(b Binding, d Dest) bool {
	if b.Route != "" {
		return d.Scheme == "gateway" && d.Route == b.Route
	}
	return d.Scheme == "https" && slices.Contains(b.Hosts, d.Host)
}

func placed(e Entry, occ []occurrence, h http.Header) bool {
	var mine []occurrence
	for _, o := range occ {
		if o.token == e.Token {
			mine = append(mine, o)
		}
	}
	b := e.Binding
	if len(mine) != 1 || mine[0].header != b.Header || len(h.Values(b.Header)) != 1 {
		return false
	}
	value := h.Get(b.Header)
	switch b.Format {
	case Raw:
		return !mine[0].basic && value == e.Token
	case Bearer:
		scheme, rest, ok := strings.Cut(value, " ")
		return !mine[0].basic && ok && strings.EqualFold(scheme, "Bearer") && rest == e.Token
	case BasicUser, BasicPassword:
		user, pass, ok := decodeBasic(value)
		if !ok || !mine[0].basic {
			return false
		}
		if b.Format == BasicUser {
			return user == e.Token
		}
		return pass == e.Token
	}
	return false
}

func scan(u *url.URL, h http.Header) []occurrence {
	var out []occurrence
	inURL := map[string]bool{}
	parts := []string{u.Host, u.EscapedPath(), u.Path, u.RawQuery, unescape(u.RawQuery), u.Opaque, unescape(u.Opaque), u.Fragment}
	if u.User != nil {
		pass, _ := u.User.Password()
		parts = append(parts, u.User.Username(), pass)
	}
	for _, part := range parts {
		for _, t := range surrogate.Find(part) {
			if !inURL[t] {
				inURL[t] = true
				out = append(out, occurrence{token: t})
			}
		}
	}
	names := make([]string, 0, len(h))
	for name := range h {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		canonical := http.CanonicalHeaderKey(name)
		for _, t := range surrogate.Find(name) {
			out = append(out, occurrence{token: t, header: "name:" + name})
		}
		for _, value := range h[name] {
			for _, t := range surrogate.Find(value) {
				out = append(out, occurrence{token: t, header: canonical})
			}
			if user, pass, ok := decodeBasic(value); ok {
				for _, t := range surrogate.Find(user + "\n" + pass) {
					out = append(out, occurrence{token: t, header: canonical, basic: true})
				}
			} else {
				for _, t := range surrogate.Find(looseBasic(value)) {
					out = append(out, occurrence{token: t, header: canonical})
				}
			}
		}
	}
	return out
}

func order(occ []occurrence) []string {
	var tokens []string
	for _, o := range occ {
		if !slices.Contains(tokens, o.token) {
			tokens = append(tokens, o.token)
		}
	}
	return tokens
}

// looseBasic decodes a Basic credential as the most lenient servers do: any whitespace after the
// scheme, the scheme in any case, either base64 alphabet, any padding, stray bytes skipped and no
// colon needed. Its result is only searched for surrogates; placed refuses every one it finds.
func looseBasic(value string) string {
	f := strings.Fields(value)
	if len(f) < 2 || !strings.EqualFold(f[0], "Basic") {
		return ""
	}
	var b strings.Builder
	for _, c := range []byte(strings.Join(f[1:], "")) {
		switch {
		case c == '-':
			b.WriteByte('+')
		case c == '_':
			b.WriteByte('/')
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			b.WriteByte(c)
		}
	}
	s := b.String()
	if len(s)%4 == 1 {
		s = s[:len(s)-1]
	}
	raw, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return ""
	}
	return string(raw)
}

var strictBase64 = base64.StdEncoding.Strict()

// decodeBasic reads only canonical Basic: the scheme in ASCII letters of any case, one space, and
// standard base64 with its padding and zero padding bits.
func decodeBasic(value string) (user, pass string, ok bool) {
	scheme, encoded, found := strings.Cut(value, " ")
	// Five bytes can only be ASCII here; EqualFold alone would also take U+017F for the s.
	if !found || len(scheme) != len("Basic") || !strings.EqualFold(scheme, "Basic") {
		return "", "", false
	}
	raw, err := strictBase64.DecodeString(encoded)
	if err != nil {
		return "", "", false
	}
	return strings.Cut(string(raw), ":")
}

// ApplySwaps rewrites each bound header with the real value, keeping its format. It reads every
// value before it writes any header, so an error leaves h untouched.
func ApplySwaps(h http.Header, swaps []Entry, value func(secretID string) ([]byte, error)) error {
	set := map[string]string{}
	for _, e := range swaps {
		real, err := value(e.Binding.SecretID)
		if err != nil {
			return err
		}
		b := e.Binding
		switch b.Format {
		case Raw:
			set[b.Header] = string(real)
		case Bearer:
			set[b.Header] = "Bearer " + string(real)
		case BasicUser, BasicPassword:
			current, ok := set[b.Header]
			if !ok {
				current = h.Get(b.Header)
			}
			user, pass, _ := decodeBasic(current)
			if b.Format == BasicUser {
				user = string(real)
			} else {
				pass = string(real)
			}
			set[b.Header] = "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
		}
	}
	for name, v := range set {
		h.Set(name, v)
	}
	return nil
}
