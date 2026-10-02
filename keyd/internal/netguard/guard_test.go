package netguard

import (
	"errors"
	"net"
	"net/netip"
	"strings"
	"testing"
)

func noOwn() ([]netip.Prefix, error) { return nil, nil }

func check(g *Guard, addr string) error {
	return g.Check(netip.AddrPortFrom(netip.MustParseAddr(addr), 443))
}

func TestStaticDenySet(t *testing.T) {
	g := New(noOwn)
	denied := map[string]string{
		"127.0.0.1":                            "loopback",
		"127.255.255.254":                      "loopback",
		"0.0.0.0":                              "this network",
		"0.1.2.3":                              "this network",
		"10.1.2.3":                             "private",
		"172.16.0.1":                           "private",
		"172.31.255.255":                       "private",
		"192.168.1.10":                         "private",
		"192.168.65.254":                       "docker desktop",
		"100.64.0.1":                           "shared address space",
		"169.254.169.254":                      "link-local",
		"224.0.0.1":                            "multicast",
		"255.255.255.255":                      "reserved",
		"198.18.0.1":                           "benchmarking",
		"192.0.2.1":                            "documentation",
		"::1":                                  "loopback",
		"::":                                   "unspecified",
		"::ffff:127.0.0.1":                     "loopback",
		"::ffff:10.0.0.1":                      "private",
		"::127.0.0.1":                          "ipv4-compatible",
		"64:ff9b::7f00:1":                      "loopback",
		"64:ff9b::a9fe:a9fe":                   "link-local",
		"2002:7f00:1::1":                       "loopback",
		"2001:0:4136:e378:8000:63bf:3fff:fdd2": "teredo",
		"fe80::1":                              "link-local",
		"fe80::1%en0":                          "link-local",
		"fd00::1":                              "unique local",
		"fc00::1":                              "unique local",
		"ff02::1":                              "multicast",
		"2001:db8::1":                          "documentation",
	}
	for addr, rule := range denied {
		err := check(g, addr)
		var d *DeniedError
		if !errors.As(err, &d) {
			t.Errorf("%s: err = %v, want DeniedError", addr, err)
			continue
		}
		if !strings.Contains(d.Rule, rule) {
			t.Errorf("%s: rule %q, want it to name %q", addr, d.Rule, rule)
		}
	}
}

func TestPublicAddressesPass(t *testing.T) {
	g := New(noOwn)
	for _, addr := range []string{"8.8.8.8", "1.1.1.1", "93.184.215.14", "2606:4700:4700::1111", "64:ff9b::808:808", "2002:808:808::1", "::ffff:8.8.8.8"} {
		if err := check(g, addr); err != nil {
			t.Errorf("%s: %v", addr, err)
		}
	}
}

func TestOwnAddressesAndConnectedNetworksAreDenied(t *testing.T) {
	own := []netip.Prefix{
		netip.MustParsePrefix("81.2.69.160/24"),
		netip.MustParsePrefix("2a01:4b00:1234:5678::abcd/64"),
	}
	g := New(func() ([]netip.Prefix, error) { return own, nil })
	for _, addr := range []string{"81.2.69.160", "81.2.69.7", "2a01:4b00:1234:5678::abcd", "2a01:4b00:1234:5678::1", "::ffff:81.2.69.7"} {
		if err := check(g, addr); err == nil {
			t.Errorf("%s passed, want it denied as the Mac's own network", addr)
		}
	}
	for _, addr := range []string{"81.2.70.1", "2a01:4b00:1234:5679::1"} {
		if err := check(g, addr); err != nil {
			t.Errorf("%s: %v", addr, err)
		}
	}
}

func TestOwnAddressesAreReadOnEveryCheck(t *testing.T) {
	current := netip.MustParsePrefix("2a01:4b00:1:2::aaaa/128")
	g := New(func() ([]netip.Prefix, error) { return []netip.Prefix{current}, nil })
	if err := check(g, "2a01:4b00:1:2::bbbb"); err != nil {
		t.Fatalf("before rotation: %v", err)
	}
	current = netip.MustParsePrefix("2a01:4b00:1:2::bbbb/128")
	if err := check(g, "2a01:4b00:1:2::bbbb"); err == nil {
		t.Fatal("a rotated temporary address passed the guard")
	}
}

func TestUnreadableOwnAddressesFailClosed(t *testing.T) {
	g := New(func() ([]netip.Prefix, error) { return nil, errors.New("sysctl failed") })
	if err := check(g, "8.8.8.8"); err == nil {
		t.Fatal("check passed without the Mac's own addresses")
	}
}

func TestAllowExceptionIsExactAddressAndPort(t *testing.T) {
	ap := netip.MustParseAddrPort("127.0.0.1:4799")
	g := New(noOwn, ap)
	if err := g.Check(ap); err != nil {
		t.Fatalf("exception: %v", err)
	}
	if err := g.Check(netip.MustParseAddrPort("127.0.0.1:4798")); err == nil {
		t.Fatal("another port on the excepted address passed")
	}
}

func TestControlRefusesBeforeConnecting(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		if c, err := ln.Accept(); err == nil {
			c.Close()
			accepted <- struct{}{}
		}
	}()
	d := net.Dialer{Control: New(noOwn).Control}
	if c, err := d.Dial("tcp4", ln.Addr().String()); err == nil {
		c.Close()
		t.Fatal("dial to loopback succeeded through Control")
	}
	select {
	case <-accepted:
		t.Fatal("the listener saw a connection")
	default:
	}
	if err := New(noOwn).Control("tcp", "not-an-address", nil); err == nil {
		t.Fatal("Control accepted an unparsable address")
	}
}

func TestInterfacePrefixesIncludeLoopback(t *testing.T) {
	prefixes, err := InterfacePrefixes()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range prefixes {
		if p.Contains(netip.MustParseAddr("127.0.0.1")) {
			return
		}
	}
	t.Fatalf("InterfacePrefixes() = %v, want the loopback network", prefixes)
}
