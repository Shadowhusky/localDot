// Package keys is keyd's surrogate registry: what each secret is bound to, the surrogates minted
// for each cell, and the inspection that decides whether a request may carry them.
package keys

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type Format string

const (
	Bearer        Format = "bearer"
	Raw           Format = "raw"
	BasicUser     Format = "basic-user"
	BasicPassword Format = "basic-password"
)

// Op is one gateway operation: a method and a path under the route's base URL, without a
// leading slash. Model marks ops whose first capture group names the model. Body names the API
// whose JSON the op takes, which says where a request carries images; Cap is the field the
// provider reads the output cap from, empty when the op writes no output; Free marks ops the
// provider does not bill.
type Op struct {
	Method string
	Path   *regexp.Regexp
	Model  bool
	Body   string
	Cap    string
	Free   bool
}

func (o Op) ModelFrom(p string) string {
	if m := o.Path.FindStringSubmatch(p); len(m) > 1 {
		return m[1]
	}
	return ""
}

// Binding is where a secret may go. HTTP secrets name exact hosts reached over https on 443;
// LLM secrets name a gateway route. FromRecord, LocalRoutes and the Registry give each binding its
// own slices and URL.
type Binding struct {
	SecretID string
	Tag      string
	Hosts    []string
	Route    string
	Upstream *url.URL
	Local    bool
	Ops      []Op
	Header   string
	Format   Format
	Methods  []string
	Paths    []string
}

// clone copies the slices and the URL; the compiled paths, which nothing edits, are shared.
func (b Binding) clone() Binding {
	b.Hosts = slices.Clone(b.Hosts)
	b.Ops = slices.Clone(b.Ops)
	b.Methods = slices.Clone(b.Methods)
	b.Paths = slices.Clone(b.Paths)
	if b.Upstream != nil {
		u := *b.Upstream
		b.Upstream = &u
	}
	return b
}

func (b Binding) Op(method, p string) (Op, bool) {
	for _, o := range b.Ops {
		if o.Method == method && o.Path.MatchString(p) {
			return o, true
		}
	}
	return Op{}, false
}

// Permits applies an HTTP binding's optional method and path limits to a decoded, clean path. A
// prefix ends at a segment: /v1 permits /v1 and /v1/x, never /v1-admin; /v1/ permits only what
// lies under it.
func (b Binding) Permits(method, p string) bool {
	if len(b.Methods) > 0 && !slices.Contains(b.Methods, method) {
		return false
	}
	if len(b.Paths) == 0 {
		return true
	}
	return slices.ContainsFunc(b.Paths, func(prefix string) bool {
		if strings.HasSuffix(prefix, "/") {
			return strings.HasPrefix(p, prefix)
		}
		return p == prefix || strings.HasPrefix(p, prefix+"/")
	})
}

var (
	// OpenAI's chat completions take max_completion_tokens, the one cap its reasoning models
	// accept; servers that copy OpenAI's API read max_tokens.
	openAIOps     = openAIStyle("max_completion_tokens")
	compatibleOps = openAIStyle("max_tokens")
	anthropicOps  = []Op{
		{Method: "POST", Path: regexp.MustCompile(`^messages$`), Body: "anthropic", Cap: "max_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^messages/count_tokens$`), Body: "anthropic", Free: true},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)},
	}
	googleOps = []Op{
		{Method: "POST", Path: regexp.MustCompile(googleModel + `(?:generateContent|streamGenerateContent)$`), Model: true, Body: "gemini", Cap: "generationConfig.maxOutputTokens"},
		{Method: "POST", Path: regexp.MustCompile(googleModel + `countTokens$`), Model: true, Body: "gemini", Free: true},
		{Method: "POST", Path: regexp.MustCompile(googleModel + `(?:embedContent|batchEmbedContents)$`), Model: true, Body: "embeddings"},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$`)},
	}
)

const googleModel = `^models/([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*):`

func openAIStyle(chatCap string) []Op {
	return []Op{
		{Method: "POST", Path: regexp.MustCompile(`^chat/completions$`), Body: "chat", Cap: chatCap},
		{Method: "POST", Path: regexp.MustCompile(`^completions$`), Body: "completions", Cap: "max_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^responses$`), Body: "responses", Cap: "max_output_tokens"},
		{Method: "POST", Path: regexp.MustCompile(`^embeddings$`), Body: "embeddings"},
		{Method: "GET", Path: regexp.MustCompile(`^models$`)},
		{Method: "GET", Path: regexp.MustCompile(`^models/[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*(/[A-Za-z0-9_:-]+(\.[A-Za-z0-9_:-]+)*)?$`)},
	}
}

type preset struct {
	base   string
	header string
	format Format
	tag    string
	ops    []Op
}

// A preset without a base takes the record's BaseURL. The first-class bearer providers (Part 5a,
// P5a-R31) have fixed bases and list only the operation their official AI SDK package calls.
var presets = map[string]preset{
	"anthropic":         {"https://api.anthropic.com/v1", "X-Api-Key", Raw, "ant", anthropicOps},
	"openai":            {"https://api.openai.com/v1", "Authorization", Bearer, "oai", openAIOps},
	"google":            {"https://generativelanguage.googleapis.com/v1beta", "X-Goog-Api-Key", Raw, "gem", googleOps},
	"xai":               {"https://api.x.ai/v1", "Authorization", Bearer, "xai", xaiOps},
	"mistral":           {"https://api.mistral.ai/v1", "Authorization", Bearer, "mis", mistralOps},
	"deepseek":          {"https://api.deepseek.com", "Authorization", Bearer, "dsk", chatOnlyOps},
	"groq":              {"https://api.groq.com/openai/v1", "Authorization", Bearer, "grq", chatOnlyOps},
	"openrouter":        {"https://openrouter.ai/api/v1", "Authorization", Bearer, "orr", openRouterOps},
	"openai-compatible": {"", "Authorization", Bearer, "llm", compatibleOps},
	"azure":             {"", "Api-Key", Raw, "azr", openAIOps},
}

// The first-class bearer providers' operations: the one their package calls, with the cap field it
// sends, and the model listings as openAIStyle writes them. xAI's package speaks only its Responses
// API; xAI's chat completions report reasoning tokens outside completion_tokens, which the meter
// would undercharge, so the xAI route has no chat operation. Mistral's and OpenRouter's chat bodies
// name the image rule keyd holds them by (llm.BodyMistral, llm.BodyOpenRouter).
var (
	chatOnlyOps   = withListings(chatOp("chat"))
	mistralOps    = withListings(chatOp("mistral"))
	openRouterOps = withListings(chatOp("openrouter"))
	xaiOps        = withListings(Op{Method: "POST", Path: regexp.MustCompile(`^responses$`), Body: "responses", Cap: "max_output_tokens"})
)

func chatOp(body string) Op {
	return Op{Method: "POST", Path: regexp.MustCompile(`^chat/completions$`), Body: body, Cap: "max_tokens"}
}

func withListings(op Op) []Op {
	return append([]Op{op}, slices.DeleteFunc(openAIStyle(""), func(o Op) bool { return o.Method != "GET" })...)
}

// LocalRoutes are the gateway's routes to model servers on the Mac's loopback. They carry no
// secret, and their names are reserved secret ids.
func LocalRoutes() map[string]Binding {
	route := func(name, base string) Binding {
		u, _ := url.Parse(base)
		return Binding{Route: name, Upstream: u, Local: true, Ops: slices.Clone(compatibleOps)}
	}
	return map[string]Binding{
		"lmstudio": route("lmstudio", "http://127.0.0.1:1234/v1"),
		"ollama":   route("ollama", "http://127.0.0.1:11434/v1"),
	}
}

var (
	headerToken = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
	forbidden   = []string{"Host", "Content-Length", "Content-Type", "Transfer-Encoding", "Connection", "Keep-Alive", "Te", "Trailer", "Upgrade", "Cookie", "Set-Cookie", "Proxy-Authorization", "Proxy-Authenticate", "Proxy-Connection"}
	methods     = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
)

func FromRecord(rec vault.Record) (Binding, error) {
	switch rec.Kind {
	case vault.KindLLM:
		return llmBinding(rec)
	case vault.KindHTTP:
		return httpBinding(rec)
	}
	return Binding{}, fmt.Errorf("keys: unknown kind %q", rec.Kind)
}

func llmBinding(rec vault.Record) (Binding, error) {
	p, ok := presets[rec.Provider]
	if !ok {
		return Binding{}, fmt.Errorf("keys: unknown provider %q", rec.Provider)
	}
	if len(rec.Hosts) > 0 || rec.Header != "" || rec.Format != "" || len(rec.Methods) > 0 || len(rec.Paths) > 0 {
		return Binding{}, errors.New("keys: an llm secret takes only a provider and, for some providers, a base URL")
	}
	base := p.base
	switch {
	case p.base == "" && rec.BaseURL == "":
		return Binding{}, fmt.Errorf("keys: provider %s needs a base URL", rec.Provider)
	case p.base != "" && rec.BaseURL != "":
		return Binding{}, fmt.Errorf("keys: provider %s has a fixed base URL", rec.Provider)
	case p.base == "":
		base = strings.TrimSuffix(rec.BaseURL, "/")
	}
	u, err := url.Parse(base)
	if reason := badBaseURL(u, err); reason != "" {
		return Binding{}, errors.New("keys: base URL " + reason)
	}
	return Binding{SecretID: rec.ID, Tag: p.tag, Route: rec.ID, Upstream: u, Ops: slices.Clone(p.ops), Header: p.header, Format: p.format}, nil
}

// badBaseURL says what is wrong with a base URL without repeating any of it: a user may have
// pasted a key into it.
func badBaseURL(u *url.URL, err error) string {
	switch {
	case err != nil:
		return "does not parse"
	case u.Scheme != "https":
		return "must use https"
	case u.User != nil:
		return "must not carry a user or password"
	case u.Port() != "" || strings.HasSuffix(u.Host, ":"):
		return "must not name a port"
	case u.RawQuery != "":
		return "must not carry a query"
	case u.Fragment != "":
		return "must not carry a fragment"
	case policy.ValidBindingHost(u.Hostname()) != nil:
		return "host is not a public, lowercase host name"
	case u.RawPath != "" && u.EscapedPath() != u.Path:
		return "path must not hold escapes"
	case u.Path != "" && path.Clean(u.Path) != u.Path:
		return "path is not clean"
	}
	return ""
}

func httpBinding(rec vault.Record) (Binding, error) {
	if rec.Provider != "" || rec.BaseURL != "" {
		return Binding{}, errors.New("keys: an http secret takes hosts, a header and a format")
	}
	if len(rec.Hosts) == 0 || len(rec.Hosts) > 16 {
		return Binding{}, errors.New("keys: an http secret needs 1-16 hosts")
	}
	for _, h := range rec.Hosts {
		if err := policy.ValidBindingHost(h); err != nil {
			return Binding{}, err
		}
	}
	if !headerToken.MatchString(rec.Header) {
		return Binding{}, fmt.Errorf("keys: header %q is not a header name", rec.Header)
	}
	header := http.CanonicalHeaderKey(rec.Header)
	if slices.Contains(forbidden, header) {
		return Binding{}, fmt.Errorf("keys: a surrogate cannot travel in %s", header)
	}
	format := Format(rec.Format)
	switch format {
	case Bearer, Raw:
	case BasicUser, BasicPassword:
		if header != "Authorization" {
			return Binding{}, errors.New("keys: basic-auth formats live in Authorization")
		}
	default:
		return Binding{}, fmt.Errorf("keys: format %q: want bearer, raw, basic-user or basic-password", rec.Format)
	}
	for _, m := range rec.Methods {
		if !slices.Contains(methods, m) {
			return Binding{}, fmt.Errorf("keys: method %q", m)
		}
	}
	// A prefix holds only what a limited request path may hold (see unambiguousPath), or it could
	// never match.
	for _, p := range rec.Paths {
		clean := path.Clean(p)
		if !strings.HasPrefix(p, "/") || clean != strings.TrimSuffix(p, "/") && clean != p || !printable(p) || strings.ContainsAny(p, `;\%?# `) || strings.Contains(p, "//") || strings.Contains(p, "/..") {
			return Binding{}, fmt.Errorf("keys: path prefix %q must be a clean absolute path of printable ASCII without ; \\ %% ? # a space, // or a segment starting with ..", p)
		}
	}
	return Binding{
		SecretID: rec.ID,
		Tag:      "key",
		Hosts:    slices.Clone(rec.Hosts),
		Header:   header,
		Format:   format,
		Methods:  slices.Clone(rec.Methods),
		Paths:    slices.Clone(rec.Paths),
	}, nil
}

func printable(s string) bool {
	return !strings.ContainsFunc(s, func(r rune) bool { return r < 0x20 || r > 0x7e })
}

// ValidValueFor adds the binding's own limits to vault.ValidValue.
func ValidValueFor(b Binding, value []byte) error {
	if err := vault.ValidValue(value); err != nil {
		return err
	}
	if b.Format == BasicUser && strings.Contains(string(value), ":") {
		return errors.New("keys: a basic-auth user cannot contain a colon")
	}
	return nil
}
