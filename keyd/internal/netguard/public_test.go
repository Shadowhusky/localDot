package netguard

import (
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// response builds a Binding success response for txid carrying the given attributes.
func response(txid []byte, attrs ...[]byte) []byte {
	msg := make([]byte, 20)
	binary.BigEndian.PutUint16(msg[0:2], stunBindingSuccess)
	binary.BigEndian.PutUint32(msg[4:8], stunMagicCookie)
	copy(msg[8:20], txid)
	for _, a := range attrs {
		msg = append(msg, a...)
	}
	binary.BigEndian.PutUint16(msg[2:4], uint16(len(msg)-20))
	return msg
}

func attr(typ uint16, val []byte) []byte {
	out := make([]byte, 4, 4+len(val)+3)
	binary.BigEndian.PutUint16(out[0:2], typ)
	binary.BigEndian.PutUint16(out[2:4], uint16(len(val)))
	out = append(out, val...)
	for len(out)%4 != 0 {
		out = append(out, 0)
	}
	return out
}

// mapped encodes addr:port as a (XOR-)MAPPED-ADDRESS value.
func mapped(addr netip.Addr, port uint16, txid []byte, xor bool) []byte {
	family := byte(0x01)
	if addr.Is6() {
		family = 0x02
	}
	raw := addr.AsSlice()
	key := binary.BigEndian.AppendUint32(nil, stunMagicCookie)
	key = append(key, txid...)
	if xor {
		port ^= uint16(stunMagicCookie >> 16)
		for i := range raw {
			raw[i] ^= key[i]
		}
	}
	val := []byte{0, family, byte(port >> 8), byte(port)}
	return append(val, raw...)
}

var txid = []byte("0123456789ab")

func TestParseBindingSuccess(t *testing.T) {
	v4 := netip.MustParseAddr("81.2.69.160")
	v6 := netip.MustParseAddr("2a01:4b00:1234:5678::abcd")
	cases := map[string]struct {
		msg  []byte
		want netip.Addr
	}{
		"xor v4":           {response(txid, attr(stunXorMappedAddress, mapped(v4, 54321, txid, true))), v4},
		"xor v6":           {response(txid, attr(stunXorMappedAddress, mapped(v6, 54321, txid, true))), v6},
		"mapped only":      {response(txid, attr(stunMappedAddress, mapped(v4, 1, nil, false))), v4},
		"xor wins":         {response(txid, attr(stunMappedAddress, mapped(netip.MustParseAddr("1.2.3.4"), 1, nil, false)), attr(stunXorMappedAddress, mapped(v4, 2, txid, true))), v4},
		"unknown skipped":  {response(txid, attr(0x8022, []byte("software")), attr(stunXorMappedAddress, mapped(v4, 2, txid, true))), v4},
		"odd length value": {response(txid, attr(0x8022, []byte("abcde")), attr(stunXorMappedAddress, mapped(v4, 2, txid, true))), v4},
	}
	for name, c := range cases {
		got, err := parseBindingSuccess(c.msg, txid)
		if err != nil || got != c.want {
			t.Errorf("%s: %v %v, want %v", name, got, err, c.want)
		}
	}
}

func TestParseBindingSuccessRefusesAnythingElse(t *testing.T) {
	good := response(txid, attr(stunXorMappedAddress, mapped(netip.MustParseAddr("81.2.69.160"), 1, txid, true)))
	wrongType := append([]byte{}, good...)
	binary.BigEndian.PutUint16(wrongType[0:2], 0x0111)
	wrongCookie := append([]byte{}, good...)
	wrongCookie[4] ^= 0xff
	longer := append([]byte{}, good...)
	binary.BigEndian.PutUint16(longer[2:4], 400)
	truncated := response(txid, []byte{0, 0x20, 0, 20, 0, 1})
	for name, msg := range map[string][]byte{
		"other transaction": response([]byte("ba9876543210"), attr(stunXorMappedAddress, mapped(netip.MustParseAddr("81.2.69.160"), 1, []byte("ba9876543210"), true))),
		"not a success":     wrongType,
		"no magic cookie":   wrongCookie,
		"length past end":   longer,
		"truncated":         truncated,
		"too short":         good[:12],
		"no address":        response(txid, attr(0x8022, []byte("software"))),
		"bad family":        response(txid, attr(stunXorMappedAddress, []byte{0, 0x03, 0, 1, 1, 2, 3, 4})),
	} {
		if a, err := parseBindingSuccess(msg, txid); err == nil {
			t.Errorf("%s: parsed %v", name, a)
		}
	}
}

// fakeSTUN answers each Binding request with addr, from its `from`th request on (1: at once),
// until the test ends, and counts what it was asked.
func fakeSTUN(t *testing.T, addr netip.Addr, from int) (string, *atomic.Int32) {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	asked := &atomic.Int32{}
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from2, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if n < 20 || binary.BigEndian.Uint16(buf[0:2]) != stunBindingRequest {
				continue
			}
			if asked.Add(1) < int32(from) {
				continue
			}
			id := append([]byte{}, buf[8:20]...)
			pc.WriteTo([]byte("noise"), from2)
			pc.WriteTo(response(id, attr(stunXorMappedAddress, mapped(addr, 40000, id, true))), from2)
		}
	}()
	return pc.LocalAddr().String(), asked
}

// fakeRouter answers NAT-PMP's external address request with addr (or stays silent for an
// invalid addr) on a loopback port, and counts what it was asked.
func fakeRouter(t *testing.T, addr netip.Addr) (Discovery, *atomic.Int32) {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	asked := &atomic.Int32{}
	go func() {
		buf := make([]byte, 64)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if n != 2 || buf[0] != 0 || buf[1] != 0 {
				continue
			}
			asked.Add(1)
			if !addr.IsValid() {
				continue
			}
			reply := []byte{0, 128, 0, 0, 0, 0, 0x30, 0x39}
			pc.WriteTo(append(reply, addr.AsSlice()...), from)
		}
	}()
	port := pc.LocalAddr().(*net.UDPAddr).Port
	loopback := func() (netip.Addr, error) { return netip.MustParseAddr("127.0.0.1"), nil }
	return Discovery{Router: loopback, NATPMPPort: port, Timeout: 300 * time.Millisecond}, asked
}

func TestLearnAsksTheRouterFirstAndNoThirdParty(t *testing.T) {
	public := &Public{}
	g := New(WithPublic(noOwn, public))
	if err := check(g, "81.2.69.160"); err != nil {
		t.Fatalf("before learning: %v", err)
	}
	d, routerAsked := fakeRouter(t, netip.MustParseAddr("81.2.69.160"))
	stun, stunAsked := fakeSTUN(t, netip.MustParseAddr("81.2.69.99"), 1)
	d.STUN = stun
	if err := public.Learn(d); err != nil {
		t.Fatal(err)
	}
	var denied *DeniedError
	if err := check(g, "81.2.69.160"); !errors.As(err, &denied) || denied.Rule != "own address 81.2.69.160/32" {
		t.Fatalf("after learning: %v", err)
	}
	if err := check(g, "81.2.69.161"); err != nil {
		t.Fatalf("a neighbour: %v", err)
	}
	if st := public.Status(); st.State != "active" || st.Source != "nat-pmp" || st.Addresses != 1 || st.CheckedAt == "" {
		t.Fatalf("status: %+v", st)
	}
	if routerAsked.Load() == 0 || stunAsked.Load() != 0 {
		t.Fatalf("router asked %d times, STUN %d", routerAsked.Load(), stunAsked.Load())
	}
}

func TestLearnAsksSTUNOnlyWhenTheRouterHasNoPublicAnswer(t *testing.T) {
	for name, router := range map[string]netip.Addr{
		"a silent router":             {},
		"a router behind another NAT": netip.MustParseAddr("192.168.0.2"),
	} {
		public := &Public{}
		d, _ := fakeRouter(t, router)
		stun, stunAsked := fakeSTUN(t, netip.MustParseAddr("81.2.69.160"), 1)
		d.STUN = stun
		if err := public.Learn(d); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if st := public.Status(); st.State != "active" || st.Source != "stun" || stunAsked.Load() != 1 {
			t.Fatalf("%s: %+v, STUN asked %d times", name, st, stunAsked.Load())
		}
		if !slices.Contains(public.Addrs(), netip.MustParseAddr("81.2.69.160")) {
			t.Fatalf("%s: learned %v", name, public.Addrs())
		}
	}
}

func TestLearnSaysUnknownWhenNothingAnswersAndKeepsWhatItHad(t *testing.T) {
	public := &Public{}
	public.add(netip.MustParseAddr("81.2.69.160"))
	d, _ := fakeRouter(t, netip.Addr{})
	silent, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	d.STUN = silent.LocalAddr().String()
	if err := public.Learn(d); err == nil {
		t.Fatal("silence counted as an answer")
	}
	st := public.Status()
	if st.State != "unknown" || !strings.Contains(st.Error, "nat-pmp") || !strings.Contains(st.Error, "stun") {
		t.Fatalf("status: %+v", st)
	}
	if got := public.Addrs(); len(got) != 1 || got[0] != netip.MustParseAddr("81.2.69.160") {
		t.Fatalf("addresses after a failed round: %v", got)
	}
	for i := range maxPublic + 4 {
		public.add(netip.AddrFrom4([4]byte{81, 2, 70, byte(i)}))
	}
	if got := public.Addrs(); len(got) != maxPublic || got[len(got)-1] != netip.AddrFrom4([4]byte{81, 2, 70, byte(maxPublic + 3)}) {
		t.Fatalf("kept %d addresses, last %v", len(got), got[len(got)-1])
	}
}

func TestLearnIsOffWithBothSourcesOff(t *testing.T) {
	public := &Public{}
	if st := public.Status(); st.State != "unknown" {
		t.Fatalf("before any round: %+v", st)
	}
	if err := public.Learn(Discovery{}); err != nil {
		t.Fatal(err)
	}
	if st := public.Status(); st.State != "off" || st.Addresses != 0 {
		t.Fatalf("status: %+v", st)
	}
}

func TestKeepAsksAgainSoonWhileTheAddressIsUnknown(t *testing.T) {
	public := &Public{}
	stun, asked := fakeSTUN(t, netip.MustParseAddr("81.2.69.160"), 3)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		public.Keep(Discovery{STUN: stun, Timeout: 100 * time.Millisecond}, time.Hour, 10*time.Millisecond, stop, t.Logf)
		close(done)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for public.Status().State != "active" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if public.Status().State != "active" || asked.Load() != 3 {
		t.Fatalf("status %+v after %d requests", public.Status(), asked.Load())
	}
	// Known now: the next round waits the long interval.
	time.Sleep(100 * time.Millisecond)
	if asked.Load() != 3 {
		t.Fatalf("asked again while known: %d", asked.Load())
	}
	close(stop)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Keep did not stop")
	}
}

func TestLearnKeepsAKnownGuardActiveForOneFailedRound(t *testing.T) {
	public := &Public{}
	d, _ := fakeRouter(t, netip.MustParseAddr("81.2.69.160"))
	if err := public.Learn(d); err != nil {
		t.Fatal(err)
	}
	lost := Discovery{Router: func() (netip.Addr, error) { return netip.Addr{}, errors.New("no route") }}
	if err := public.Learn(lost); err == nil {
		t.Fatal("a failed round counted as an answer")
	}
	if st := public.Status(); st.State != "active" || st.Source != "nat-pmp" || !strings.Contains(st.Error, "no route") {
		t.Fatalf("after one failed round: %+v", st)
	}
	public.Learn(lost)
	if st := public.Status(); st.State != "unknown" {
		t.Fatalf("after two failed rounds: %+v", st)
	}
	if err := public.Learn(d); err != nil || public.Status().State != "active" {
		t.Fatalf("an answer again: %v, %+v", err, public.Status())
	}
	public.Learn(lost)
	if st := public.Status(); st.State != "active" {
		t.Fatalf("the grace comes back with an answer: %+v", st)
	}
}

func TestKeepAsksLessOftenAfterAFewFailedRounds(t *testing.T) {
	public := &Public{}
	stun, asked := fakeSTUN(t, netip.MustParseAddr("81.2.69.160"), 1000)
	stop := make(chan struct{})
	defer close(stop)
	go public.Keep(Discovery{STUN: stun, Timeout: 5 * time.Millisecond}, time.Hour, 10*time.Millisecond, stop, t.Logf)
	time.Sleep(500 * time.Millisecond)
	if n := asked.Load(); n != quickRetries {
		t.Fatalf("asked %d times in 0.5 s, want %d and then the long interval", n, quickRetries)
	}
}

func TestKeepAsksAtOnceWhenTheGatewayChanges(t *testing.T) {
	public := &Public{}
	d, routerAsked := fakeRouter(t, netip.MustParseAddr("81.2.69.160"))
	var gateway atomic.Value
	gateway.Store(netip.MustParseAddr("127.0.0.1"))
	d.Router = func() (netip.Addr, error) { return gateway.Load().(netip.Addr), nil }
	stop := make(chan struct{})
	defer close(stop)
	go public.Keep(d, time.Hour, 10*time.Millisecond, stop, t.Logf)
	deadline := time.Now().Add(3 * time.Second)
	for public.Status().State != "active" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if st, n := public.Status(), routerAsked.Load(); st.State != "active" || n != 1 {
		t.Fatalf("before the change: %+v, router asked %d times", st, n)
	}
	// Another network: its router is asked at once, not after the long interval.
	gateway.Store(netip.MustParseAddr("127.0.0.2"))
	time.Sleep(100 * time.Millisecond)
	gateway.Store(netip.MustParseAddr("127.0.0.1"))
	for routerAsked.Load() < 2 && time.Now().Before(deadline.Add(2*time.Second)) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := routerAsked.Load(); n < 2 {
		t.Fatalf("the router was not asked again after the gateway changed (%d)", n)
	}
}
