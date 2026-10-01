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
	if err := checkNetwork(network, address); err != nil {
		return nil, err
	}
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
