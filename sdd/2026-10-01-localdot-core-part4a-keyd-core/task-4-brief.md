### Task 4: The SSRF guard — resolve, check, dial the checked address, check again

S4 showed why a static list is not enough: `0.0.0.0` and `::` reach loopback-only listeners, and
the Mac's own global and temporary IPv6 addresses passed iron-proxy's guard (S4 "keyd requirement:
the SSRF deny set"). The guard denies the static ranges, every address of every interface on the
Mac and the networks they sit in, and reads the interfaces at every check, so a rotated temporary
address is never stale (~31 µs per read on the development Mac, P4a-R7). It looks through
IPv4-mapped, NAT64 and 6to4 forms to the IPv4 address they carry. The dialer resolves the name
itself, refuses the name if any answer is denied (a public-plus-private answer is a rebinding
shape), dials only checked addresses with `net.Dialer.Control` checking again at connect time, and
checks the connected peer once more. An exception list (exact address and port) exists for tests
only; production passes none. This is the dial-time check the spec adapts from iron-proxy, rebuilt
around a live deny set.

**Files:**
- Create: `keyd/internal/netguard/guard.go`, `keyd/internal/netguard/dialer.go`
- Test: `keyd/internal/netguard/guard_test.go`, `keyd/internal/netguard/dialer_test.go`

**Interfaces:**
- Produces: `New(own func() ([]netip.Prefix, error), allow ...netip.AddrPort) *Guard`,
  `(*Guard).Check(netip.AddrPort) error`, `(*Guard).Control(network, address string, c syscall.RawConn) error`,
  `InterfacePrefixes() ([]netip.Prefix, error)`, `DeniedError{Target, Rule string}` (the rule names
  the range, such as `loopback 127.0.0.0/8`, `docker desktop 192.168.65.0/24`, `own address …`,
  `connected network …`); `Resolver interface { LookupNetIP(ctx, network, host string) ([]netip.Addr, error) }`
  (`*net.Resolver` satisfies it), `ResolveError{Host string; Err error}`,
  `Dialer{Guard *Guard; Resolver Resolver; Timeout time.Duration}` with
  `DialContext(ctx, network, address string) (net.Conn, error)`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/netguard/guard_test.go`:
```go
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
```

`keyd/internal/netguard/dialer_test.go`:
```go
package netguard

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"testing"
	"time"
)

type fakeResolver struct {
	answers map[string][][]netip.Addr
	calls   map[string]int
}

func (f *fakeResolver) LookupNetIP(_ context.Context, _ string, host string) ([]netip.Addr, error) {
	if f.calls == nil {
		f.calls = map[string]int{}
	}
	seq, ok := f.answers[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	i := min(f.calls[host], len(seq)-1)
	f.calls[host]++
	return seq[i], nil
}

func addrs(s ...string) []netip.Addr {
	out := make([]netip.Addr, len(s))
	for i, a := range s {
		out[i] = netip.MustParseAddr(a)
	}
	return out
}

func listen(t *testing.T) (net.Listener, netip.AddrPort, chan struct{}) {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	seen := make(chan struct{}, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			seen <- struct{}{}
			c.Close()
		}
	}()
	return ln, netip.MustParseAddrPort(ln.Addr().String()), seen
}

func noConnection(t *testing.T, seen chan struct{}) {
	t.Helper()
	select {
	case <-seen:
		t.Fatal("the listener saw a connection")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestDialerRefusesANameThatResolvesToLoopback(t *testing.T) {
	_, ap, seen := listen(t)
	r := &fakeResolver{answers: map[string][][]netip.Addr{"rebind.example.test": {addrs("127.0.0.1")}}}
	d := &Dialer{Guard: New(noOwn), Resolver: r}
	_, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("rebind.example.test", strconv.Itoa(int(ap.Port()))))
	var denied *DeniedError
	if !errors.As(err, &denied) {
		t.Fatalf("err = %v, want DeniedError", err)
	}
	noConnection(t, seen)
}

func TestDialerRefusesAMixOfPublicAndPrivateAnswers(t *testing.T) {
	_, ap, seen := listen(t)
	r := &fakeResolver{answers: map[string][][]netip.Addr{"mixed.example.test": {addrs("8.8.8.8", "127.0.0.1")}}}
	d := &Dialer{Guard: New(noOwn), Resolver: r}
	_, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("mixed.example.test", strconv.Itoa(int(ap.Port()))))
	if !errors.As(err, new(*DeniedError)) {
		t.Fatalf("err = %v, want DeniedError", err)
	}
	noConnection(t, seen)
}

func TestDialerRefusesIPLiterals(t *testing.T) {
	_, ap, seen := listen(t)
	d := &Dialer{Guard: New(noOwn), Resolver: &fakeResolver{}}
	for _, addr := range []string{ap.String(), "[::ffff:127.0.0.1]:" + strconv.Itoa(int(ap.Port())), "0.0.0.0:" + strconv.Itoa(int(ap.Port()))} {
		if _, err := d.DialContext(context.Background(), "tcp", addr); !errors.As(err, new(*DeniedError)) {
			t.Errorf("%s: err = %v, want DeniedError", addr, err)
		}
	}
	noConnection(t, seen)
}

func TestDialerConnectsToAnAllowedAddressAndPinsIt(t *testing.T) {
	_, ap, seen := listen(t)
	r := &fakeResolver{answers: map[string][][]netip.Addr{"api.example.test": {addrs("127.0.0.1"), addrs("10.0.0.1")}}}
	d := &Dialer{Guard: New(noOwn, ap), Resolver: r}
	c, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("api.example.test", strconv.Itoa(int(ap.Port()))))
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	<-seen
	// The second lookup rebinds to a private address and must be refused.
	if _, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("api.example.test", strconv.Itoa(int(ap.Port())))); !errors.As(err, new(*DeniedError)) {
		t.Fatalf("rebound dial: %v", err)
	}
}

func TestDialerReportsResolveFailures(t *testing.T) {
	d := &Dialer{Guard: New(noOwn), Resolver: &fakeResolver{answers: map[string][][]netip.Addr{"empty.example.test": {nil}}}}
	for _, host := range []string{"missing.example.test", "empty.example.test"} {
		_, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort(host, "443"))
		var re *ResolveError
		if !errors.As(err, &re) {
			t.Errorf("%s: err = %v, want ResolveError", host, err)
		}
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/netguard/`
Expected: FAIL — `[build failed]`, starting `internal/netguard/guard_test.go:13:15: undefined: Guard`.

- [ ] **Step 3: Implement the guard and the dialer**

`keyd/internal/netguard/guard.go`:
```go
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
	r("2001:db8::/32", "documentation"),
	r("fc00::/7", "unique local"),
	r("fe80::/10", "link-local"),
	r("fec0::/10", "site-local"),
	r("ff00::/8", "multicast"),
}

var (
	nat64     = netip.MustParsePrefix("64:ff9b::/96")
	sixToFour = netip.MustParsePrefix("2002::/16")
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
func (g *Guard) Control(_, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return &DeniedError{Target: address, Rule: "unparsable dial address"}
	}
	return g.Check(ap)
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
```

`keyd/internal/netguard/dialer.go`:
```go
package netguard

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"time"
)

// Resolver is satisfied by *net.Resolver.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

type ResolveError struct {
	Host string
	Err  error
}

func (e *ResolveError) Error() string { return fmt.Sprintf("netguard: resolve %s: %v", e.Host, e.Err) }
func (e *ResolveError) Unwrap() error { return e.Err }

// Dialer resolves, checks every answer, then dials only checked addresses, IPv4 first.
type Dialer struct {
	Guard    *Guard
	Resolver Resolver
	Timeout  time.Duration
}

func (d *Dialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || port == 0 {
		return nil, fmt.Errorf("netguard: bad port in %q", address)
	}
	ips, err := d.resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	targets := make([]netip.AddrPort, 0, len(ips))
	for _, ip := range ips {
		ap := netip.AddrPortFrom(ip.Unmap(), uint16(port))
		// One denied answer refuses the name: a mix of public and private answers is a rebinding shape.
		if err := d.Guard.Check(ap); err != nil {
			return nil, err
		}
		targets = append(targets, ap)
	}
	slices.SortStableFunc(targets, func(a, b netip.AddrPort) int {
		return rank(a) - rank(b)
	})
	timeout := d.Timeout
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	nd := net.Dialer{Timeout: timeout, Control: d.Guard.Control}
	var errs []error
	for _, ap := range targets {
		c, err := nd.DialContext(ctx, network, ap.String())
		if err != nil {
			errs = append(errs, err)
			if ctx.Err() != nil {
				break
			}
			continue
		}
		peer, perr := netip.ParseAddrPort(c.RemoteAddr().String())
		if perr != nil {
			c.Close()
			return nil, &DeniedError{Target: c.RemoteAddr().String(), Rule: "unparsable peer address"}
		}
		if err := d.Guard.Check(peer); err != nil {
			c.Close()
			return nil, err
		}
		return c, nil
	}
	return nil, errors.Join(errs...)
}

func (d *Dialer) resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if ip, err := netip.ParseAddr(host); err == nil {
		return []netip.Addr{ip}, nil
	}
	ips, err := d.Resolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, &ResolveError{Host: host, Err: err}
	}
	if len(ips) == 0 {
		return nil, &ResolveError{Host: host, Err: errors.New("no addresses")}
	}
	return ips, nil
}

func rank(ap netip.AddrPort) int {
	if ap.Addr().Is4() {
		return 0
	}
	return 1
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/netguard/`
Expected: `ok` (13 tests). No test leaves the Mac: denied dials never connect, and the one allowed
dial goes to a loopback listener through an exact exception.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/netguard
git commit -m "feat(keyd): dial-time SSRF guard"
```

---
