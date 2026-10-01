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
