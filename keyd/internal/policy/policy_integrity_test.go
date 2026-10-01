package policy

import (
	"net"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// Characters a tool might unescape are built from code points.
var (
	dottedI = string(rune(0x130))  // lower-cases to "i"
	kelvin  = string(rune(0x212a)) // lower-cases to "k"
	uUmlaut = string(rune(0xfc))
	nul     = string(rune(0))
	tab     = string(rune(9))
	newline = string(rune(10))
	// 443 in Arabic-Indic digits.
	arabic443 = string([]rune{0x664, 0x664, 0x663})
)

// numericSpellings are addresses written so that a parser, not a reader, sees the number. macOS's
// resolver answers each one without brackets, a trailing dot or an IPv4 zone locally, without
// asking DNS.
var numericSpellings = []string{
	"0177.0.0.1", "0177.1", "017700000001", "00177.0.0.1", "0177.0.0.01",
	"0x7f000001", "0X7F000001", "0x7f.0x1", "0x7f.0x0.0x0.0x1", "0X7F.0X0.0X0.0X1",
	"127.1", "127.0.1", "10.1", "192.168.257", "169.254.43518", "2130706433", "2852039166", "0", "0x0", "0.0",
	"0x7f.1", "0177.0x0.1", "127.0x0.0.1", "0xa9.254.0251.0376", "0300.0xa8.1.1",
	"127.0.0.1", "0.0.0.0", "169.254.169.254", "255.255.255.255",
	"127.0.0.1.", "127.1.", "0x7f.0x1.", "2130706433.", "0177.0.0.1.",
	"::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "::ffff:169.254.169.254",
	"fe80::1%en0", "fe80::1%25en0", "::1.", "127.0.0.1%en0",
	"[::1]", "[::]", "[::ffff:127.0.0.1]", "[::FFFF:7F00:1]", "[0:0:0:0:0:0:0:1]", "[fe80::1%25en0]", "[fe80::1%en0]",
	"[127.0.0.1]", "[127.1]",
}

func withPort(host, port string) string {
	if strings.HasPrefix(host, "[") {
		return host + ":" + port
	}
	return net.JoinHostPort(host, port)
}

func TestEveryNumericSpellingIsRefusedNeverAllowed(t *testing.T) {
	for _, s := range numericSpellings {
		forms := []struct {
			hostport    string
			defaultPort int
		}{{withPort(s, "443"), 0}, {s, 80}, {withPort(s, "80"), 80}}
		for _, f := range forms {
			if _, reason := ParseHostPort(f.hostport, f.defaultPort); reason != ReasonIPLiteral && reason != ReasonHostInvalid {
				t.Errorf("ParseHostPort(%q, %d) reason %q, want ip-literal or host-invalid", f.hostport, f.defaultPort, reason)
			}
		}
		if err := ValidBindingHost(s); err == nil {
			t.Errorf("%q accepted as a binding host", s)
		}
	}
}

func TestASpellingOfABoundOrDeniedHostIsDecidedAsTheHostItself(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	brain, _ := ForRole(Brain)
	bound := map[string]bool{"api.example.test": true, "keyd.example.test": true}
	for _, in := range []string{"API.Example.TEST.:443", "api.example.test.:443", "API.EXAMPLE.TEST:443"} {
		got, reason := ParseHostPort(in, 0)
		if reason != "" || got != (Target{Host: "api.example.test", Port: 443}) {
			t.Fatalf("ParseHostPort(%q) = %+v, %q", in, got, reason)
		}
		for _, p := range []Policy{desktop, brain} {
			if d := p.Connect(got, bound); d != (Decision{Allow: true, MITM: true}) {
				t.Errorf("%s as %s: %+v, want it intercepted", in, p.Role, d)
			}
		}
		if err := ValidBindingHost(strings.TrimSuffix(in, ":443")); err == nil {
			t.Errorf("%q accepted as a binding host", in)
		}
	}
	for _, c := range []struct {
		hostport    string
		defaultPort int
	}{{"PRINTER.LOCAL.:443", 0}, {"Foo.LocalHost.:443", 0}, {"Metadata.Google.Internal.:443", 0}, {"KEYD.LDOT.:443", 0}, {"NAS.Home.ARPA.:80", 80}, {"Router.LAN.", 80}, {"LLM.Ldot.", 80}} {
		got, reason := ParseHostPort(c.hostport, c.defaultPort)
		if reason != "" {
			t.Fatalf("ParseHostPort(%q) reason %q", c.hostport, reason)
		}
		d := desktop.PlainHTTP(got)
		if c.defaultPort == 0 {
			d = desktop.Connect(got, bound)
		}
		if d != (Decision{Reason: ReasonHostDenied}) {
			t.Errorf("%s: %+v, want it denied", c.hostport, d)
		}
	}
	// Only one trailing dot is dropped, and never a leading one.
	for _, in := range []string{"api.example.test..:443", "api.example.test...:443", ".api.example.test:443"} {
		if _, reason := ParseHostPort(in, 0); reason != ReasonHostInvalid {
			t.Errorf("ParseHostPort(%q) reason %q, want host-invalid", in, reason)
		}
	}
	// Non-ASCII letters that lower-case to ASCII may be refused, but must never take a bound host
	// around keyd, or reach a denied one.
	for _, in := range []string{"ap" + dottedI + ".example.test:443", kelvin + "eyd.example.test:443", "AP" + dottedI + ".example.test.:443"} {
		got, reason := ParseHostPort(in, 0)
		if d := desktop.Connect(got, bound); reason == "" && !d.MITM {
			t.Errorf("%q: %+v, %+v: a bound host went around keyd", in, got, d)
		}
	}
	for _, in := range []string{"pr" + dottedI + "nter.local:443", kelvin + "eyd.ldot:443"} {
		got, reason := ParseHostPort(in, 0)
		if d := desktop.Connect(got, bound); reason == "" && d.Allow {
			t.Errorf("%q: %+v, %+v: a denied host was allowed", in, got, d)
		}
	}
}

func TestTheDenyListMatchesWholeLabels(t *testing.T) {
	for _, h := range []string{"localhost", "a.localhost", "a.b.localhost", "x.local", "a.b.local", "x.internal", "x.intranet", "x.private", "x.corp", "x.home", "x.lan", "x.home.arpa", "a.b.home.arpa", "x.ldot"} {
		if !Denied(h) {
			t.Errorf("%s is not denied", h)
		}
	}
	for _, h := range []string{"evil-localhost", "localhost.evil.test", "x.evil-localhost", "evillocalhost.test", "x.localhostx", "api.mylan", "x.notlocal", "shop.myhome.arpa", "x.home.arpa.example", "x.local.example.com", "home.example", "corp.example.com", "x.privatex", "intranet.example", "ldot.example", "x.arpa"} {
		if Denied(h) {
			t.Errorf("%s is denied", h)
		}
	}
	desktop, _ := ForRole(Desktop)
	cases := map[string]Decision{
		"localhost.evil.test:443": {Allow: true},
		"x.local.example.com:443": {Allow: true},
		"shop.myhome.arpa:443":    {Allow: true},
		"foo.localhost:443":       {Reason: ReasonHostDenied},
		"a.b.home.arpa:443":       {Reason: ReasonHostDenied},
	}
	for in, want := range cases {
		got, reason := ParseHostPort(in, 0)
		if d := desktop.Connect(got, nil); reason != "" || d != want {
			t.Errorf("%s: %q %+v, want %+v", in, reason, d, want)
		}
	}
	// Glued to a deny entry, the last label is no top-level domain, so the host is no name at all.
	for _, in := range []string{"evil-localhost:443", "x.evil-localhost:443"} {
		if _, reason := ParseHostPort(in, 0); reason != ReasonHostInvalid {
			t.Errorf("ParseHostPort(%q) reason %q, want host-invalid", in, reason)
		}
	}
}

func TestCONNECTIsFor443AndPlainHTTPFor80Only(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	bound := map[string]bool{"api.example.test": true}
	for _, host := range []string{"example.com", "api.example.test"} {
		for _, port := range []int{1, 22, 80, 442, 444, 8443, 65535} {
			if d := desktop.Connect(Target{host, port}, bound); d != (Decision{Reason: ReasonPort}) {
				t.Errorf("CONNECT %s:%d: %+v", host, port, d)
			}
		}
		for _, port := range []int{1, 22, 79, 81, 443, 8080, 65535} {
			if d := desktop.PlainHTTP(Target{host, port}); d != (Decision{Reason: ReasonPort}) {
				t.Errorf("http %s:%d: %+v", host, port, d)
			}
		}
	}
}

func TestMalformedAndOutOfRangePortsAreRefused(t *testing.T) {
	for _, p := range []string{"", "0", "-1", "-443", "65536", "99999", "4294967739", "0x1bb", "1_443", "443.0", "1e3", " 443", "443 ", "4 43", "443a", arabic443} {
		for _, def := range []int{0, 80} {
			if _, reason := ParseHostPort("example.test:"+p, def); reason != ReasonHostInvalid {
				t.Errorf("ParseHostPort(%q, %d) reason %q, want host-invalid", "example.test:"+p, def, reason)
			}
		}
	}
	for _, port := range []int{1, 443, 65535} {
		in := net.JoinHostPort("example.test", strconv.Itoa(port))
		if got, reason := ParseHostPort(in, 0); reason != "" || got != (Target{"example.test", port}) {
			t.Errorf("ParseHostPort(%q) = %+v, %q", in, got, reason)
		}
	}
}

func TestValidBindingHostAcceptsOnlyANormalisedPublicName(t *testing.T) {
	label63 := strings.Repeat("a", 63)
	name253 := strings.Join([]string{label63, label63, label63, strings.Repeat("b", 61)}, ".")
	for _, h := range []string{"api.example.test", "postman-echo.com", "xn--bcher-kva.example", "api.xn--p1ai", "a1.b2.example", "123.example", "x--y.example", "localhost.example.com", "ldot.example", label63 + ".example", name253} {
		if err := ValidBindingHost(h); err != nil {
			t.Errorf("%s: %v", h, err)
		}
		// The binding check and the CONNECT path normalise alike, so a bound host is found again.
		if got, reason := ParseHostPort(net.JoinHostPort(h, "443"), 0); reason != "" || got.Host != h {
			t.Errorf("ParseHostPort(%s:443) = %+v, %q", h, got, reason)
		}
	}
	refused := []string{
		"", ".", "example", "localhost", "api.example.test.", ".api.example.test", "api..example.test", "api.example.test..",
		"API.EXAMPLE.TEST", "api.example.Test", "*.example.test", "*", "x-.example.test", "-x.example.test",
		label63 + "a.example", name253 + "b",
		"api.example.test:443", "[api.example.test]", " api.example.test", "api.example.test ", "api.example.test" + newline,
		"api.example.test" + nul, "api" + tab + ".example.test", "api.example.test/", "https://api.example.test",
		"user@api.example.test", "api%2eexample.test", "api_example.test", "api.example.test#x", "api.example.test?x",
		"b" + uUmlaut + "cher.example", "ap" + dottedI + ".example.test", kelvin + "eyd.example.test",
		"api.example.c0m", "api.example.123", "api.example.a-b", "example.xn--", "example.xn-1", "example.9xn--9",
		"foo.localhost", "printer.local", "metadata.google.internal", "x.intranet", "x.private", "x.corp", "x.home",
		"router.lan", "nas.home.arpa", "llm.ldot", "keyd.ldot",
	}
	for _, h := range append(refused, numericSpellings...) {
		if err := ValidBindingHost(h); err == nil {
			t.Errorf("%q accepted as a binding host", h)
		}
	}
}

func TestDecisionsCheckThePortThenTheBindingThenTheRole(t *testing.T) {
	desktop, _ := ForRole(Desktop)
	browser, _ := ForRole(Browser)
	brain, _ := ForRole(Brain)
	bound := map[string]bool{"api.example.test": true}
	connect := []struct {
		name   string
		p      Policy
		target Target
		bound  map[string]bool
		want   Decision
	}{
		{"browser passthrough", browser, Target{"example.com", 443}, bound, Decision{Allow: true}},
		{"browser bound host", browser, Target{"api.example.test", 443}, bound, Decision{Allow: true, MITM: true}},
		{"browser deny list", browser, Target{"printer.local", 443}, bound, Decision{Reason: ReasonHostDenied}},
		{"brain port before role", brain, Target{"example.com", 8443}, bound, Decision{Reason: ReasonPort}},
		{"brain bound host on another port", brain, Target{"api.example.test", 8443}, bound, Decision{Reason: ReasonPort}},
		{"brain role before deny list", brain, Target{"printer.local", 443}, bound, Decision{Reason: ReasonNoWeb}},
		{"no bound hosts", desktop, Target{"api.example.test", 443}, nil, Decision{Allow: true}},
		{"zero policy has no web", Policy{}, Target{"example.com", 443}, bound, Decision{Reason: ReasonNoWeb}},
	}
	for _, c := range connect {
		if got := c.p.Connect(c.target, c.bound); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
	plain := []struct {
		name   string
		p      Policy
		target Target
		want   Decision
	}{
		{"browser web", browser, Target{"example.com", 80}, Decision{Allow: true}},
		{"plain http never intercepts", desktop, Target{"api.example.test", 80}, Decision{Allow: true}},
		{"brain port before role", brain, Target{"example.com", 8080}, Decision{Reason: ReasonPort}},
		{"brain role before deny list", brain, Target{"nas.home.arpa", 80}, Decision{Reason: ReasonNoWeb}},
		{"brain bound host", brain, Target{"api.example.test", 80}, Decision{Reason: ReasonNoWeb}},
	}
	for _, c := range plain {
		if got := c.p.PlainHTTP(c.target); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

// Audit lines and the X-Keyd-Reason header carry the reasons, and the admin API names roles so.
func TestReasonsAndRolesKeepTheirWireNames(t *testing.T) {
	got := []string{ReasonHostInvalid, ReasonIPLiteral, ReasonPort, ReasonHostDenied, ReasonNoWeb, string(Brain), string(Desktop), string(Browser)}
	want := []string{"host-invalid", "ip-literal", "port-not-allowed", "host-denied", "web-not-allowed", "brain", "desktop", "browser"}
	if !slices.Equal(got, want) {
		t.Errorf("wire names %q, want %q", got, want)
	}
}

func TestForRoleRefusesEveryOtherRoleWithNoEgress(t *testing.T) {
	for _, r := range []Role{"", "Brain", "DESKTOP", " browser", "browser ", "gateway", "web", "root"} {
		if p, err := ForRole(r); err == nil || p != (Policy{}) {
			t.Errorf("ForRole(%q) = %+v, %v", r, p, err)
		}
	}
}
