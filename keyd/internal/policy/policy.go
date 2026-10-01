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
