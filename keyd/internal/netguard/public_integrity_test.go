package netguard

import (
	"errors"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestStopCancelsAnInflightDiscoveryRead(t *testing.T) {
	p := &Public{}
	d, asked := fakeRouter(t, netip.Addr{})
	d.Timeout = 3 * time.Second
	stop, done := make(chan struct{}), make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(stop) }) }
	go func() {
		p.Keep(d, time.Hour, time.Second, stop, func(string, ...any) {})
		close(done)
	}()
	defer func() { finish(); <-done }()
	deadline := time.Now().Add(3 * time.Second)
	for asked.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if asked.Load() == 0 {
		t.Fatal("the request did not reach the silent router")
	}
	finish()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Stop left the discovery socket waiting for its network timeout")
	}
}

func TestStoppedDiscoveryMakesNoRequest(t *testing.T) {
	p := &Public{}
	d, asked := fakeRouter(t, netip.MustParseAddr("81.2.69.160"))
	stop := make(chan struct{})
	close(stop)
	p.Keep(d, time.Hour, time.Second, stop, func(string, ...any) {})
	if asked.Load() != 0 {
		t.Fatalf("stopped discovery sent %d requests", asked.Load())
	}
}

func TestStopDuringRouterLookupCannotStartSTUN(t *testing.T) {
	p := &Public{}
	stun, asked := fakeSTUN(t, netip.MustParseAddr("81.2.69.160"), 1)
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	d := Discovery{STUN: stun, Timeout: time.Second, Router: func() (netip.Addr, error) {
		if calls.Add(1) == 2 { // Keep's gateway snapshot, then Learn's actual lookup.
			close(entered)
			<-release
		}
		return netip.Addr{}, errors.New("no router")
	}}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		p.Keep(d, time.Hour, time.Second, stop, func(string, ...any) {})
		close(done)
	}()
	<-entered
	close(stop)
	close(release)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("discovery did not finish")
	}
	if asked.Load() != 0 {
		t.Fatalf("STUN received %d requests after shutdown", asked.Load())
	}
}

func TestChangedNetworkDoesNotBorrowTheOldAddressesGrace(t *testing.T) {
	p := &Public{}
	failed := make(chan PublicStatus, quickRetries+1)
	d, _ := fakeRouter(t, netip.MustParseAddr("81.2.69.160"))
	var moved atomic.Bool
	d.Router = func() (netip.Addr, error) {
		if moved.Load() {
			return netip.MustParseAddr("127.0.0.2"), nil
		}
		return netip.MustParseAddr("127.0.0.1"), nil
	}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		p.Keep(d, time.Hour, 10*time.Millisecond, stop, func(string, ...any) { failed <- p.Status() })
		close(done)
	}()
	defer func() { close(stop); <-done }()
	deadline := time.Now().Add(3 * time.Second)
	for p.Status().State != "active" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if p.Status().State != "active" {
		t.Fatal("initial network was not learned")
	}
	moved.Store(true)
	select {
	case got := <-failed:
		if got.State != "unknown" {
			t.Fatalf("a new network with no answer was reported as %s", got.State)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the changed network was not queried")
	}
	if len(p.Addrs()) != 1 {
		t.Fatal("changing networks discarded the previously denied address")
	}
}
