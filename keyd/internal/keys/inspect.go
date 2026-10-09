package keys

import (
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"path"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
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

// steps, when a test sets it, is told of every token lookup and comparison Inspect makes, so a pin
// can bound its work by counting rather than timing.
var steps func(n int)

func countSteps(n int) {
	if steps != nil {
		steps(n)
	}
}

type occurrence struct {
	token  string
	header string
	basic  bool
	// folded marks a token found in a lower-cased header name, which Inspect resolves to the
	// registered token it folds from.
	folded bool
}

// Inspect finds every surrogate-shaped token in the request line, its host, user information and
// opaque form included, and the headers. Each must be a surrogate of this cell, bound to this
// destination, appear exactly once, and sit exactly in its bound header in its bound format;
// otherwise the request is refused. An absolute-form target must also name d.Host, as the policy
// writes it: the limits are d's, so a request bound elsewhere is refused, with or without a surrogate.
func (r *Registry) Inspect(d Dest, method string, u *url.URL, h http.Header) Verdict {
	occ := scan(u, h)
	for i, o := range occ {
		if o.folded {
			if e, ok := r.lookupFolded(o.token); ok {
				occ[i].token = e.Token
			}
		}
	}
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
	if !targets(u, d) {
		reason := ReasonSurrogatePolicy
		if len(v.Swaps) > 0 {
			reason = ReasonMisplacedSurrogate
		}
		return Verdict{Reason: reason, SecretID: v.SecretID, SurrogateID: v.SurrogateID}
	}
	v.Allow = true
	return v
}

// targets reports whether u, if it names a host, names d's once the policy has normalised it. A
// CONNECT to an address names it as policy.ParseAddress writes it.
func targets(u *url.URL, d Dest) bool {
	if u.Host == "" {
		return true
	}
	t, reason := policy.ParseHostPort(u.Host, 443)
	if reason == policy.ReasonIPLiteral {
		t, reason = policy.ParseAddress(u.Host)
	}
	return reason == "" && t.Host == d.Host
}

// permitted applies an HTTP binding's method and path limits. A limited binding matches only a path
// every server reads the same way: decoded, clean (one trailing slash allowed), printable ASCII,
// without ;, ?, #, a space or a backslash, with no segment that starts with two dots, and with no encoded
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
	if !strings.HasPrefix(p, "/") || !printable(p) || strings.ContainsAny(p, `;\?# `) || strings.Contains(p, "/..") {
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
	countSteps(len(occ))
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
		// net/http canonicalises a name (ld_ becomes Ld_, the rest lower case), so names are
		// searched lower-cased; the token found is the registered one only in lower case.
		for _, t := range surrogate.Find(strings.ToLower(name)) {
			out = append(out, occurrence{token: t, header: "name:" + name, folded: true})
		}
		for _, value := range h[name] {
			for _, t := range surrogate.Find(value) {
				out = append(out, occurrence{token: t, header: canonical})
			}
			if user, pass, ok := decodeBasic(value); ok {
				for _, t := range surrogate.Find(user + "\n" + pass) {
					out = append(out, occurrence{token: t, header: canonical, basic: true})
				}
				continue
			}
			found := map[string]bool{}
			for _, decoded := range looseBasic(value) {
				for _, t := range surrogate.Find(decoded) {
					if !found[t] {
						found[t] = true
						out = append(out, occurrence{token: t, header: canonical})
					}
				}
			}
		}
	}
	return out
}

// order lists each token once, in the order first found.
func order(occ []occurrence) []string {
	var tokens []string
	seen := make(map[string]bool, len(occ))
	for _, o := range occ {
		countSteps(1)
		if !seen[o.token] {
			seen[o.token] = true
			tokens = append(tokens, o.token)
		}
	}
	return tokens
}

// looseBasic decodes a Basic credential as the most lenient servers do: any whitespace after the
// scheme (including a credential glued to the prefix), the scheme in any case, either base64 alphabet, any padding, stray bytes skipped and no
// colon needed. A server may also split the credential where it likes, so it is decoded joined, field
// by field (fields end at whitespace or commas) and chunk by chunk (chunks end at =), each at every
// base64 alignment. Its results are only searched for surrogates; placed refuses every one found.
func looseBasic(value string) []string {
	f := strings.FieldsFunc(value, func(r rune) bool { return unicode.IsSpace(r) || r == ',' })
	scheme := slices.IndexFunc(f, func(s string) bool {
		return strings.EqualFold(s, "Basic") || len(s) >= 5 && strings.EqualFold(s[:5], "Basic")
	})
	if scheme < 0 {
		return nil
	}
	prefix := 5
	if strings.EqualFold(f[scheme], "Basic") {
		prefix = len(f[scheme])
	}
	credentials := append([]string{f[scheme][prefix:]}, f[scheme+1:]...)
	joined := strings.Join(credentials, "")
	pieces := append(append([]string{joined}, credentials...), strings.Split(joined, "=")...)
	var out []string
	for _, piece := range pieces {
		letters := base64Letters(piece)
		for shift := 0; shift < 4 && shift < len(letters); shift++ {
			s := letters[shift:]
			if len(s)%4 == 1 {
				s = s[:len(s)-1]
			}
			if raw, err := base64.RawStdEncoding.DecodeString(s); err == nil {
				out = append(out, string(raw))
			}
		}
	}
	return out
}

// base64Letters keeps the letters of either base64 alphabet, written in the standard one.
func base64Letters(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c == '-':
			b.WriteByte('+')
		case c == '_':
			b.WriteByte('/')
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '+', c == '/':
			b.WriteByte(c)
		}
	}
	return b.String()
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

// ApplySwaps rewrites each bound header with the real value, keeping its format. It first checks
// that every surrogate still sits where Inspect placed it and that the headers hold no other, then
// reads every value before it writes any header, so an error leaves h untouched. A Basic header is
// decoded once, from h, and encoded once with both halves swapped.
func ApplySwaps(h http.Header, swaps []Entry, value func(secretID string) ([]byte, error)) error {
	occ := scan(&url.URL{}, h)
	for _, e := range swaps {
		if !placed(e, occ, h) {
			return errors.New("keys: surrogate:" + e.ID + " is no longer where Inspect found it")
		}
	}
	for _, o := range occ {
		if !slices.ContainsFunc(swaps, func(e Entry) bool { return e.Token == o.token }) {
			return errors.New("keys: the headers hold surrogate:" + surrogate.ID(o.token) + ", which Inspect did not see")
		}
	}
	set := map[string]string{}
	halves := map[string][2]string{}
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
			pair, ok := halves[b.Header]
			if !ok {
				pair[0], pair[1], _ = decodeBasic(h.Get(b.Header))
			}
			if b.Format == BasicUser {
				pair[0] = string(real)
			} else {
				pair[1] = string(real)
			}
			halves[b.Header] = pair
		}
	}
	for name, pair := range halves {
		set[name] = "Basic " + base64.StdEncoding.EncodeToString([]byte(pair[0]+":"+pair[1]))
	}
	for name, v := range set {
		h.Set(name, v)
	}
	return nil
}
