package netguard

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"sync/atomic"
	"testing"
)

// The allowed answer comes first, so a dialer that checked answers one at a time would connect to it.
func TestDialerNeverDialsTheAllowedHalfOfAMixedAnswer(t *testing.T) {
	_, ap, seen := listen(t)
	r := &fakeResolver{answers: map[string][][]netip.Addr{"mixed.example.test": {{ap.Addr(), netip.MustParseAddr("10.0.0.1")}}}}
	d := &Dialer{Guard: New(noOwn, ap), Resolver: r}
	c, err := d.DialContext(context.Background(), "tcp", net.JoinHostPort("mixed.example.test", strconv.Itoa(int(ap.Port()))))
	if c != nil {
		c.Close()
	}
	if !errors.As(err, new(*DeniedError)) {
		t.Fatalf("err = %v, want DeniedError", err)
	}
	noConnection(t, seen)
}

// A dial to 0.0.0.0 lands on loopback (S4). The exception lets 0.0.0.0 past the lookup check and
// Control, so only the check of the connected peer can refuse it.
func TestDialerChecksTheConnectedPeer(t *testing.T) {
	_, ap, _ := listen(t)
	unspecified := netip.AddrPortFrom(netip.IPv4Unspecified(), ap.Port())
	d := &Dialer{Guard: New(noOwn, unspecified), Resolver: &fakeResolver{}}
	c, err := d.DialContext(context.Background(), "tcp", unspecified.String())
	if c != nil {
		c.Close()
	}
	var denied *DeniedError
	if !errors.As(err, &denied) || denied.Target != ap.Addr().String() {
		t.Fatalf("err = %v, want the connected peer %s denied", err, ap.Addr())
	}
}

// The address becomes the Mac's own after the lookup check, as a rotating temporary address can.
// UDP, because a UDP connect sends nothing, so even a missing Control could not reach past the Mac.
func TestDialerChecksAgainAtConnectTime(t *testing.T) {
	target := netip.MustParseAddr("93.184.215.14")
	var reads atomic.Int32
	own := func() ([]netip.Prefix, error) {
		if reads.Add(1) == 1 {
			return nil, nil
		}
		return []netip.Prefix{netip.PrefixFrom(target, 32)}, nil
	}
	r := &fakeResolver{answers: map[string][][]netip.Addr{"rotating.example.test": {{target}}}}
	d := &Dialer{Guard: New(own), Resolver: r}
	c, err := d.DialContext(context.Background(), "udp", "rotating.example.test:443")
	if c != nil {
		c.Close()
	}
	var op *net.OpError
	if !errors.As(err, new(*DeniedError)) || !errors.As(err, &op) || op.Op != "dial" {
		t.Fatalf("err = %v, want net.Dialer to refuse the dial through Control", err)
	}
}
