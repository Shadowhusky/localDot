// Package netguard keeps keyd's upstream connections off the Mac, its networks and every
// non-public address: names are resolved by keyd, every answer is checked, the checked address is
// dialled, net.Dialer.Control checks it again at connect time and the connected peer once more.
package netguard

import (
	"fmt"
	"net"
	"net/netip"
	"syscall"
)

type rule struct {
	prefix netip.Prefix
	name   string
}

func r(cidr, name string) rule { return rule{netip.MustParsePrefix(cidr), name + " " + cidr} }

// Order matters only for the name reported: specific ranges come before the ones containing them.
var static = []rule{
	r("0.0.0.0/8", "this network"),
	r("10.0.0.0/8", "private"),
	r("100.64.0.0/10", "shared address space"),
	r("127.0.0.0/8", "loopback"),
	r("169.254.0.0/16", "link-local"),
	r("172.16.0.0/12", "private"),
	r("192.0.0.0/24", "protocol assignments"),
	r("192.0.2.0/24", "documentation"),
	r("192.168.65.0/24", "docker desktop"),
	r("192.168.0.0/16", "private"),
	r("198.18.0.0/15", "benchmarking"),
	r("198.51.100.0/24", "documentation"),
	r("203.0.113.0/24", "documentation"),
	r("224.0.0.0/4", "multicast"),
	r("240.0.0.0/4", "reserved"),
	r("168.63.129.16/32", "cloud metadata"),
	r("::/128", "unspecified"),
	r("::1/128", "loopback"),
	r("::/96", "ipv4-compatible"),
	r("64:ff9b:1::/48", "local nat64"),
	r("100::/64", "discard"),
	r("2001::/32", "teredo"),
	r("2001:2::/48", "benchmarking"),
	r("2001:10::/28", "orchid"),
	r("2001:20::/28", "orchid v2"),
	r("2001:db8::/32", "documentation"),
	r("3fff::/20", "documentation"),
	r("fc00::/7", "unique local"),
	r("fe80::/10", "link-local"),
	r("fec0::/10", "site-local"),
	r("ff00::/8", "multicast"),
}

var (
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
	// Other IPv6 space is special-purpose. NAT64's embedded IPv4 is checked below.
	globalUnicast = netip.MustParsePrefix("2000::/3")
)

// DeniedError is returned for every refused address.
type DeniedError struct {
	Target string
	Rule   string
}

func (e *DeniedError) Error() string {
	return fmt.Sprintf("netguard: %s denied (%s)", e.Target, e.Rule)
}

// Guard decides whether an address may be dialled. own returns the Mac's interface addresses
// with their prefix lengths; it is called on every check, so rotating addresses are never stale.
type Guard struct {
	own   func() ([]netip.Prefix, error)
	allow map[netip.AddrPort]bool
}

// New builds a guard. allow lists exact address:port exceptions; production passes none.
func New(own func() ([]netip.Prefix, error), allow ...netip.AddrPort) *Guard {
	g := &Guard{own: own, allow: map[netip.AddrPort]bool{}}
	for _, ap := range allow {
		g.allow[normalize(ap)] = true
	}
	return g
}

func (g *Guard) Check(ap netip.AddrPort) error {
	ap = normalize(ap)
	if !ap.Addr().IsValid() {
		return &DeniedError{Target: ap.String(), Rule: "invalid address"}
	}
	if g.allow[ap] {
		return nil
	}
	addr := ap.Addr()
	own, err := g.own()
	if err != nil {
		return &DeniedError{Target: addr.String(), Rule: "own addresses unavailable: " + err.Error()}
	}
	for _, a := range embedded(addr) {
		for _, s := range static {
			if s.prefix.Contains(a) {
				return &DeniedError{Target: addr.String(), Rule: s.name}
			}
		}
		if a.Is6() && !globalUnicast.Contains(a) && !nat64.Contains(a) {
			return &DeniedError{Target: addr.String(), Rule: "outside global unicast 2000::/3"}
		}
		for _, p := range own {
			if p.Addr() == a {
				return &DeniedError{Target: addr.String(), Rule: "own address " + p.String()}
			}
			if p.Masked().Contains(a) {
				return &DeniedError{Target: addr.String(), Rule: "connected network " + p.Masked().String()}
			}
		}
	}
	return nil
}

// Control is a net.Dialer.Control hook: Go calls it with the literal ip:port about to be connected.
func (g *Guard) Control(network, address string, _ syscall.RawConn) error {
	if err := checkNetwork(network, address); err != nil {
		return err
	}
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return &DeniedError{Target: address, Rule: "unparsable dial address"}
	}
	return g.Check(ap)
}

// checkNetwork refuses every network but TCP and UDP: the address of a Unix socket is a path,
// which can read as a public ip:port.
func checkNetwork(network, address string) error {
	switch network {
	case "tcp", "tcp4", "tcp6", "udp", "udp4", "udp6":
		return nil
	}
	return &DeniedError{Target: address, Rule: fmt.Sprintf("network %q", network)}
}

// InterfacePrefixes returns every address of every interface with its network's prefix length.
func InterfacePrefixes() ([]netip.Prefix, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	out := make([]netip.Prefix, 0, len(addrs))
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip, ok := netip.AddrFromSlice(ipnet.IP)
		if !ok {
			continue
		}
		ones, bits := ipnet.Mask.Size()
		ip = ip.Unmap()
		if ip.Is4() && bits == 128 {
			ones -= 96
		}
		if bits == 0 {
			ones = ip.BitLen()
		}
		if p := netip.PrefixFrom(ip, ones); p.IsValid() {
			out = append(out, p)
		}
	}
	return out, nil
}

func normalize(ap netip.AddrPort) netip.AddrPort {
	return netip.AddrPortFrom(ap.Addr().WithZone("").Unmap(), ap.Port())
}

// embedded adds the IPv4 address that a NAT64 or 6to4 address carries.
func embedded(a netip.Addr) []netip.Addr {
	out := []netip.Addr{a}
	if !a.Is6() {
		return out
	}
	b := a.As16()
	switch {
	case nat64.Contains(a):
		out = append(out, netip.AddrFrom4([4]byte(b[12:16])))
	case sixToFour.Contains(a):
		out = append(out, netip.AddrFrom4([4]byte(b[2:6])))
	}
	return out
}
