### Task 8: Egress policy — by role, by port, by name

"Default egress: brain → the LLM gateway only. Desktop → the web and package registries, minus a
deny list and the SSRF set. Signed-in browser → the web." Policy works on names; the guard (Task 4)
works on addresses. IP literals are refused outright, because a literal skips the name rules and
carries no SNI to check (P4a-R5), and so is any name whose last label is not a top-level domain's
shape — letters, or an IDN's `xn--` form — which is how `127.1` and `0x7f.0x1` (which macOS's
resolver turns into 127.0.0.1) pass for names (review 1, M1). CONNECT goes only to port 443 and
plain HTTP only to port 80. A host one of the cell's surrogates is bound to is always reachable for
that cell, over CONNECT, and is intercepted. The deny list matches whole labels: local and reserved
names that no cell may reach by name.

**Files:**
- Create: `keyd/internal/policy/policy.go`
- Test: `keyd/internal/policy/policy_test.go`

**Interfaces:**
- Produces: reasons `ReasonHostInvalid = "host-invalid"`, `ReasonIPLiteral = "ip-literal"`,
  `ReasonPort = "port-not-allowed"`, `ReasonHostDenied = "host-denied"`, `ReasonNoWeb = "web-not-allowed"`;
  `Role` (`Brain`, `Desktop`, `Browser`), `Policy{Role; Web, Gateway bool}`, `ForRole(Role) (Policy, error)`;
  `Target{Host string; Port int}`, `Decision{Allow, MITM bool; Reason string}`;
  `ParseHostPort(hostport string, defaultPort int) (Target, string)` (0 makes the port required;
  lower-cases, drops one trailing dot); `(Policy).Connect(t Target, intercepted map[string]bool) Decision`;
  `(Policy).PlainHTTP(t Target) Decision`; `Denied(host string) bool`;
  `ValidBindingHost(host string) error`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/policy/policy_test.go`:
```go
package policy

import (
	"strings"
	"testing"
)

func TestParseHostPortNormalisesNames(t *testing.T) {
	cases := map[string]Target{
		"API.Example.TEST:443":      {Host: "api.example.test", Port: 443},
		"api.example.test.:443":     {Host: "api.example.test", Port: 443},
		"xn--bcher-kva.example:443": {Host: "xn--bcher-kva.example", Port: 443},
		"xn--d1acufc.xn--p1ai:443":  {Host: "xn--d1acufc.xn--p1ai", Port: 443},
	}
	for in, want := range cases {
		got, reason := ParseHostPort(in, 0)
		if reason != "" || got != want {
			t.Errorf("ParseHostPort(%q) = %+v, %q; want %+v", in, got, reason, want)
		}
	}
	if got, reason := ParseHostPort("example.test", 80); reason != "" || got.Port != 80 {
		t.Errorf("default port: %+v %q", got, reason)
	}
	if _, reason := ParseHostPort("[::ffff:127.0.0.1]", 80); reason != ReasonIPLiteral {
		t.Errorf("bracketed literal without a port: %q", reason)
	}
}

func TestParseHostPortRefusesWhatPolicyCannotName(t *testing.T) {
	cases := map[string]string{
		"127.0.0.1:443":                          ReasonIPLiteral,
		"[::1]:443":                              ReasonIPLiteral,
		"[::ffff:127.0.0.1]:443":                 ReasonIPLiteral,
		"0.0.0.0:443":                            ReasonIPLiteral,
		"[::]:443":                               ReasonIPLiteral,
		"2130706433:443":                         ReasonHostInvalid,
		"0x7f.0x1:443":                           ReasonHostInvalid,
		"0x7f.0x0.0x0.0x1:443":                   ReasonHostInvalid,
		"api.example.c0m:443":                    ReasonHostInvalid,
		"localhost:443":                          ReasonHostInvalid,
		"metadata:80":                            ReasonHostInvalid,
		"bad_host.example:443":                   ReasonHostInvalid,
		"user@example.test:443":                  ReasonHostInvalid,
		"-x.example.test:443":                    ReasonHostInvalid,
		"a..b.example:443":                       ReasonHostInvalid,
		"example.test:0":                         ReasonHostInvalid,
		"example.test:99999":                     ReasonHostInvalid,
		"example.test":                           ReasonHostInvalid,
		strings.Repeat("a", 64) + ".example:443": ReasonHostInvalid,
		"bücher.example:443":                     ReasonHostInvalid,
	}
	for in, want := range cases {
		if _, reason := ParseHostPort(in, 0); reason != want {
			t.Errorf("ParseHostPort(%q) reason %q, want %q", in, reason, want)
		}
	}
}

func TestDenyList(t *testing.T) {
	for _, h := range []string{"foo.localhost", "printer.local", "metadata.google.internal", "nas.home.arpa", "router.lan", "llm.ldot", "keyd.ldot"} {
		if !Denied(h) {
			t.Errorf("%s is not denied", h)
		}
	}
	for _, h := range []string{"example.com", "api.example.test", "localhost.example.com", "local.example.com", "notldot.example"} {
		if Denied(h) {
			t.Errorf("%s is denied", h)
		}
	}
}

func TestRoles(t *testing.T) {
	cases := map[Role]Policy{
		Brain:   {Role: Brain, Gateway: true},
		Desktop: {Role: Desktop, Web: true},
		Browser: {Role: Browser, Web: true},
	}
	for role, want := range cases {
		got, err := ForRole(role)
		if err != nil || got != want {
			t.Errorf("ForRole(%s) = %+v, %v", role, got, err)
		}
	}
	if _, err := ForRole("root"); err == nil {
		t.Fatal("unknown role accepted")
	}
}

func TestConnectDecisions(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	brain, _ := ForRole(Brain)
	bound := map[string]bool{"api.example.test": true}
	cases := []struct {
		name   string
		p      Policy
		target Target
		want   Decision
	}{
		{"desktop passthrough", desktop, Target{"example.com", 443}, Decision{Allow: true}},
		{"desktop bound host is intercepted", desktop, Target{"api.example.test", 443}, Decision{Allow: true, MITM: true}},
		{"brain bound host is intercepted", brain, Target{"api.example.test", 443}, Decision{Allow: true, MITM: true}},
		{"brain has no web", brain, Target{"example.com", 443}, Decision{Reason: ReasonNoWeb}},
		{"tls on 443 only", desktop, Target{"example.com", 8443}, Decision{Reason: ReasonPort}},
		{"deny list", desktop, Target{"printer.local", 443}, Decision{Reason: ReasonHostDenied}},
	}
	for _, c := range cases {
		if got := c.p.Connect(c.target, bound); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestPlainHTTPDecisions(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	brain, _ := ForRole(Brain)
	cases := []struct {
		name   string
		p      Policy
		target Target
		want   Decision
	}{
		{"desktop web", desktop, Target{"ports.ubuntu.com", 80}, Decision{Allow: true}},
		{"http on 80 only", desktop, Target{"example.com", 8080}, Decision{Reason: ReasonPort}},
		{"deny list", desktop, Target{"nas.home.arpa", 80}, Decision{Reason: ReasonHostDenied}},
		{"brain has no web", brain, Target{"example.com", 80}, Decision{Reason: ReasonNoWeb}},
	}
	for _, c := range cases {
		if got := c.p.PlainHTTP(c.target); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestValidBindingHost(t *testing.T) {
	for _, h := range []string{"api.example.test", "postman-echo.com"} {
		if err := ValidBindingHost(h); err != nil {
			t.Errorf("%s: %v", h, err)
		}
	}
	for _, h := range []string{"API.example.test", "127.0.0.1", "0x7f.0x1", "localhost", "printer.local", "api.example.test.", "*.example.test"} {
		if err := ValidBindingHost(h); err == nil {
			t.Errorf("%s accepted as a binding host", h)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/policy/`
Expected: FAIL — `[build failed]`, starting `internal/policy/policy_test.go:9:22: undefined: Target`.

- [ ] **Step 3: Implement the policy**

`keyd/internal/policy/policy.go`:
```go
// Package policy decides where a cell may connect: by role, by port, by name. It works on names
// only; addresses are netguard's job, and IP literals are refused so no request skips the names.
package policy

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

const (
	ReasonHostInvalid = "host-invalid"
	ReasonIPLiteral   = "ip-literal"
	ReasonPort        = "port-not-allowed"
	ReasonHostDenied  = "host-denied"
	ReasonNoWeb       = "web-not-allowed"
)

type Role string

const (
	Brain   Role = "brain"
	Desktop Role = "desktop"
	Browser Role = "browser"
)

// Policy is a cell's egress: Web is the general web, Gateway the LLM gateway.
type Policy struct {
	Role    Role
	Web     bool
	Gateway bool
}

func ForRole(r Role) (Policy, error) {
	switch r {
	case Brain:
		return Policy{Role: r, Gateway: true}, nil
	case Desktop, Browser:
		return Policy{Role: r, Web: true}, nil
	}
	return Policy{}, fmt.Errorf("policy: unknown role %q", r)
}

type Target struct {
	Host string
	Port int
}

type Decision struct {
	Allow  bool
	MITM   bool
	Reason string
}

// Connect decides a CONNECT. intercepted holds the hosts keyd terminates for this cell.
func (p Policy) Connect(t Target, intercepted map[string]bool) Decision {
	if t.Port != 443 {
		return Decision{Reason: ReasonPort}
	}
	if intercepted[t.Host] {
		return Decision{Allow: true, MITM: true}
	}
	return p.web(t)
}

// PlainHTTP decides an absolute-form http:// request. keyd never swaps on one.
func (p Policy) PlainHTTP(t Target) Decision {
	if t.Port != 80 {
		return Decision{Reason: ReasonPort}
	}
	return p.web(t)
}

func (p Policy) web(t Target) Decision {
	if !p.Web {
		return Decision{Reason: ReasonNoWeb}
	}
	if Denied(t.Host) {
		return Decision{Reason: ReasonHostDenied}
	}
	return Decision{Allow: true}
}

// ParseHostPort validates and normalises host:port. defaultPort 0 makes the port required.
// It returns a reason when the target cannot be used.
func ParseHostPort(hostport string, defaultPort int) (Target, string) {
	host, portText, err := net.SplitHostPort(hostport)
	if err != nil {
		if defaultPort == 0 {
			return Target{}, ReasonHostInvalid
		}
		host, portText = hostport, strconv.Itoa(defaultPort)
		if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
			host = host[1 : len(host)-1]
		}
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return Target{}, ReasonHostInvalid
	}
	if _, err := netip.ParseAddr(host); err == nil {
		return Target{}, ReasonIPLiteral
	}
	host = strings.TrimSuffix(strings.ToLower(host), ".")
	if !validName(host) {
		return Target{}, ReasonHostInvalid
	}
	return Target{Host: host, Port: port}, ""
}

// Denied reports whether host is a local or reserved name that no cell may reach by name.
func Denied(host string) bool {
	if host == "localhost" {
		return true
	}
	for _, suffix := range deniedSuffixes {
		if strings.HasSuffix(host, "."+suffix) {
			return true
		}
	}
	return false
}

var deniedSuffixes = []string{"localhost", "local", "internal", "intranet", "private", "corp", "home", "lan", "home.arpa", "ldot"}

// ValidBindingHost accepts only a normalised public name: a secret is bound to exact hosts.
func ValidBindingHost(host string) error {
	t, reason := ParseHostPort(net.JoinHostPort(host, "443"), 0)
	if reason != "" || t.Host != host || Denied(host) {
		return fmt.Errorf("policy: %q is not a public, lowercase host name", host)
	}
	return nil
}

func validName(host string) bool {
	if len(host) == 0 || len(host) > 253 {
		return false
	}
	labels := strings.Split(host, ".")
	if len(labels) < 2 {
		return false
	}
	for _, l := range labels {
		if len(l) == 0 || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for _, c := range []byte(l) {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	// A name ends in a top-level domain: letters, or an IDN's xn-- form. Addresses spelled as names
	// (127.1, 0x7f.0x1) never do.
	tld := labels[len(labels)-1]
	return strings.HasPrefix(tld, "xn--") || !strings.ContainsFunc(tld, func(r rune) bool { return r < 'a' || r > 'z' })
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/policy/`
Expected: `ok` (7 tests).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/policy
git commit -m "feat(keyd): egress policy by role, port and name"
```

---
