package netguard

import (
	"errors"
	"net/netip"
	"runtime"
	"testing"
)

func TestEveryStaticRuleAndEmbeddedFormIsDenied(t *testing.T) {
	g := New(noOwn)
	denied := map[string]string{
		"192.0.0.170":            "protocol assignments 192.0.0.0/24",
		"198.51.100.7":           "documentation 198.51.100.0/24",
		"203.0.113.7":            "documentation 203.0.113.0/24",
		"168.63.129.16":          "cloud metadata 168.63.129.16/32",
		"100.100.100.200":        "shared address space 100.64.0.0/10",
		"fd00:ec2::254":          "unique local fc00::/7",
		"64:ff9b:1::a00:1":       "local nat64 64:ff9b:1::/48",
		"100::1":                 "discard 100::/64",
		"fec0::1":                "site-local fec0::/10",
		"::ffff:0.0.0.0":         "this network 0.0.0.0/8",
		"::ffff:169.254.169.254": "link-local 169.254.0.0/16",
		"::ffff:192.168.65.254":  "docker desktop 192.168.65.0/24",
		"64:ff9b::":              "this network 0.0.0.0/8",
		"64:ff9b::a00:1":         "private 10.0.0.0/8",
		"64:ff9b::c0a8:41fe":     "docker desktop 192.168.65.0/24",
		"2002::1":                "this network 0.0.0.0/8",
		"2002:a9fe:a9fe::1":      "link-local 169.254.0.0/16",
		"2002:c0a8:41fe::1":      "docker desktop 192.168.65.0/24",

		"0.0.0.0":         "this network 0.0.0.0/8",
		"0.255.255.255":   "this network 0.0.0.0/8",
		"10.0.0.0":        "private 10.0.0.0/8",
		"10.255.255.255":  "private 10.0.0.0/8",
		"100.64.0.0":      "shared address space 100.64.0.0/10",
		"100.127.255.255": "shared address space 100.64.0.0/10",
		"127.0.0.0":       "loopback 127.0.0.0/8",
		"127.255.255.255": "loopback 127.0.0.0/8",
		"169.254.0.0":     "link-local 169.254.0.0/16",
		"169.254.255.255": "link-local 169.254.0.0/16",
		"172.16.0.0":      "private 172.16.0.0/12",
		"172.31.255.255":  "private 172.16.0.0/12",
		"192.0.0.0":       "protocol assignments 192.0.0.0/24",
		"192.0.0.255":     "protocol assignments 192.0.0.0/24",
		"192.0.2.0":       "documentation 192.0.2.0/24",
		"192.0.2.255":     "documentation 192.0.2.0/24",
		"192.168.64.255":  "private 192.168.0.0/16",
		"192.168.65.0":    "docker desktop 192.168.65.0/24",
		"192.168.65.255":  "docker desktop 192.168.65.0/24",
		"192.168.66.0":    "private 192.168.0.0/16",
		"192.168.0.0":     "private 192.168.0.0/16",
		"192.168.255.255": "private 192.168.0.0/16",
		"198.18.0.0":      "benchmarking 198.18.0.0/15",
		"198.19.255.255":  "benchmarking 198.18.0.0/15",
		"198.51.100.0":    "documentation 198.51.100.0/24",
		"198.51.100.255":  "documentation 198.51.100.0/24",
		"203.0.113.0":     "documentation 203.0.113.0/24",
		"203.0.113.255":   "documentation 203.0.113.0/24",
		"224.0.0.0":       "multicast 224.0.0.0/4",
		"239.255.255.255": "multicast 224.0.0.0/4",
		"240.0.0.0":       "reserved 240.0.0.0/4",
		"255.255.255.255": "reserved 240.0.0.0/4",
		"::":              "unspecified ::/128",
		"::1":             "loopback ::1/128",
		"::2":             "ipv4-compatible ::/96",
		"::ffff:ffff":     "ipv4-compatible ::/96",

		"64:ff9b:1:0:0:0:0:0":                     "local nat64 64:ff9b:1::/48",
		"64:ff9b:1:ffff:ffff:ffff:ffff:ffff":      "local nat64 64:ff9b:1::/48",
		"100:0:0:0:0:0:0:0":                       "discard 100::/64",
		"100:0:0:0:ffff:ffff:ffff:ffff":           "discard 100::/64",
		"2001:0:0:0:0:0:0:0":                      "teredo 2001::/32",
		"2001:0:ffff:ffff:ffff:ffff:ffff:ffff":    "teredo 2001::/32",
		"2001:db8:0:0:0:0:0:0":                    "documentation 2001:db8::/32",
		"2001:db8:ffff:ffff:ffff:ffff:ffff:ffff":  "documentation 2001:db8::/32",
		"fc00:0:0:0:0:0:0:0":                      "unique local fc00::/7",
		"fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "unique local fc00::/7",
		"fe80:0:0:0:0:0:0:0":                      "link-local fe80::/10",
		"febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "link-local fe80::/10",
		"fec0:0:0:0:0:0:0:0":                      "site-local fec0::/10",
		"feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "site-local fec0::/10",
		"ff00:0:0:0:0:0:0:0":                      "multicast ff00::/8",
		"ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff": "multicast ff00::/8",
	}
	for addr, rule := range denied {
		err := check(g, addr)
		var d *DeniedError
		if !errors.As(err, &d) || d.Rule != rule {
			t.Errorf("%s: err = %v, want it denied by %q", addr, err, rule)
		}
	}
	// Just outside a range, where no other rule takes over: each pins an edge.
	for _, addr := range []string{
		"1.0.0.0", "9.255.255.255", "11.0.0.0", "100.63.255.255", "100.128.0.0", "126.255.255.255",
		"128.0.0.0", "169.253.255.255", "169.255.0.0", "172.15.255.255", "172.32.0.0",
		"191.255.255.255", "192.0.1.0", "192.0.1.255", "192.0.3.0", "192.167.255.255", "192.169.0.0",
		"198.17.255.255", "198.20.0.0", "198.51.99.255", "198.51.101.0", "203.0.112.255",
		"203.0.114.0", "223.255.255.255", "168.63.129.15", "168.63.129.17",
		"::1:0:0", "64:ff9b:0:ffff:ffff:ffff:ffff:ffff", "64:ff9b:2::",
		"ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "100:0:0:1::", "2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
		"2001:1::", "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::",
		"fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe00::", "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
	} {
		if err := check(g, addr); err != nil {
			t.Errorf("%s: %v, want it to pass", addr, err)
		}
	}
}

func TestCheckRefusesTheZeroAddress(t *testing.T) {
	for _, g := range []*Guard{New(noOwn), New(noOwn, netip.AddrPort{})} {
		if err := g.Check(netip.AddrPort{}); !errors.As(err, new(*DeniedError)) {
			t.Fatalf("Check(netip.AddrPort{}) = %v, want it denied", err)
		}
	}
}

func TestOwnAddressesAreDeniedInEmbeddedForms(t *testing.T) {
	own := []netip.Prefix{netip.MustParsePrefix("81.2.69.160/24")}
	g := New(func() ([]netip.Prefix, error) { return own, nil })
	denied := map[string]string{
		"64:ff9b::5102:45a0": "own address 81.2.69.160/24",
		"2002:5102:4507::1":  "connected network 81.2.69.0/24",
	}
	for addr, rule := range denied {
		err := check(g, addr)
		var d *DeniedError
		if !errors.As(err, &d) || d.Rule != rule {
			t.Errorf("%s: err = %v, want it denied by %q", addr, err, rule)
		}
	}
}

func TestInterfacePrefixesKeepTheNetworkLength(t *testing.T) {
	prefixes, err := InterfacePrefixes()
	if err != nil {
		t.Fatal(err)
	}
	want := netip.MustParsePrefix("127.0.0.1/8")
	for _, p := range prefixes {
		if p == want {
			return
		}
	}
	t.Fatalf("InterfacePrefixes() = %v, want %v: the network, not only the address", prefixes, want)
}

// lo0 carries fe80::1/64 on macOS; Linux's lo has only ::1/128.
func TestInterfacePrefixesKeepTheIPv6NetworkLength(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("only macOS gives lo0 a link-local network")
	}
	prefixes, err := InterfacePrefixes()
	if err != nil {
		t.Fatal(err)
	}
	want := netip.MustParsePrefix("fe80::1/64")
	for _, p := range prefixes {
		if p == want {
			return
		}
	}
	t.Fatalf("InterfacePrefixes() = %v, want %v", prefixes, want)
}
