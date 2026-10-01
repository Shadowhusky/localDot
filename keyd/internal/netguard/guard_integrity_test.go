package netguard

import (
	"errors"
	"net/netip"
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
	}
	for addr, rule := range denied {
		err := check(g, addr)
		var d *DeniedError
		if !errors.As(err, &d) || d.Rule != rule {
			t.Errorf("%s: err = %v, want it denied by %q", addr, err, rule)
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
