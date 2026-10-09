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
		Brain:     {Role: Brain, Gateway: true},
		Desktop:   {Role: Desktop, Web: true},
		Browser:   {Role: Browser, Web: true},
		Judge:     {Role: Judge, Bound: true},
		Connector: {Role: Connector, Web: true},
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
	judge, _ := ForRole(Judge)
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
		{"judge bound host is intercepted", judge, Target{"api.example.test", 443}, Decision{Allow: true, MITM: true}},
		{"judge has no web", judge, Target{"example.com", 443}, Decision{Reason: ReasonNoWeb}},
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
	judge, _ := ForRole(Judge)
	cases := []struct {
		name   string
		p      Policy
		target Target
		want   Decision
	}{
		{"desktop web", desktop, Target{"ports.ubuntu.com", 80}, Decision{Allow: true}},
		{"judge has no web", judge, Target{"example.com", 80}, Decision{Reason: ReasonNoWeb}},
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

func TestOtherDecisions(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	brain, _ := ForRole(Brain)
	bound := map[string]bool{"api.example.test": true}
	cases := []struct {
		name   string
		p      Policy
		target Target
		want   Decision
	}{
		{"another port asks", desktop, Target{"chat.example.com", 8080}, Decision{Ask: true}},
		{"plain http by name is web traffic", desktop, Target{"example.com", 80}, Decision{Allow: true}},
		{"an address on the web's ports is web traffic", desktop, Target{"203.0.113.9", 443}, Decision{Allow: true}},
		{"an address on plain http is web traffic", desktop, Target{"203.0.113.9", 80}, Decision{Allow: true}},
		{"an address on another port asks", desktop, Target{"203.0.113.9", 8080}, Decision{Ask: true}},
		{"smtp never", desktop, Target{"mail.example.com", 25}, Decision{Reason: ReasonSMTP}},
		{"smtp to an address never", desktop, Target{"203.0.113.9", 25}, Decision{Reason: ReasonSMTP}},
		{"a bound host only on 443", desktop, Target{"api.example.test", 8443}, Decision{Reason: ReasonBoundPort}},
		{"a bound host never on plain http", desktop, Target{"api.example.test", 80}, Decision{Reason: ReasonBoundPort}},
		{"deny list", desktop, Target{"printer.local", 9100}, Decision{Reason: ReasonHostDenied}},
		{"brain has no web", brain, Target{"example.com", 8080}, Decision{Reason: ReasonNoWeb}},
		{"brain reaches no address", brain, Target{"203.0.113.9", 443}, Decision{Reason: ReasonNoWeb}},
	}
	for _, c := range cases {
		if got := c.p.Other(c.target, bound); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestParseAddress(t *testing.T) {
	good := map[string]Target{
		"203.0.113.9:8080":           {"203.0.113.9", 8080},
		"[2001:db8::1]:443":          {"2001:db8::1", 443},
		"[::ffff:203.0.113.9]:5222":  {"203.0.113.9", 5222},
		"[2001:DB8:0:0:0:0:0:1]:443": {"2001:db8::1", 443},
	}
	for in, want := range good {
		if got, reason := ParseAddress(in); reason != "" || got != want {
			t.Errorf("ParseAddress(%q) = %+v, %q", in, got, reason)
		}
	}
	for _, in := range []string{"203.0.113.9", "203.0.113.9:0", "203.0.113.9:080", "[fe80::1%eth0]:443", "example.com:443", "203.0.113.9:65536"} {
		if _, reason := ParseAddress(in); reason != ReasonHostInvalid {
			t.Errorf("ParseAddress(%q) = %q, want %q", in, reason, ReasonHostInvalid)
		}
	}
}
