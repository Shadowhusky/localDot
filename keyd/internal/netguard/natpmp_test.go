package netguard

import (
	"net/netip"
	"strings"
	"testing"
)

func TestParseNATPMP(t *testing.T) {
	ok := []byte{0, 128, 0, 0, 0, 0, 0x30, 0x39, 81, 2, 69, 160}
	if a, err := parseNATPMP(ok); err != nil || a != netip.MustParseAddr("81.2.69.160") {
		t.Fatalf("an answer: %v %v", a, err)
	}
	for name, c := range map[string]struct {
		msg  []byte
		want string
	}{
		"a PCP-only router": {[]byte{2, 0x80, 0, 1, 0, 0, 0, 0}, "PCP only"},
		"a refusal":         {[]byte{0, 128, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0}, "result code 2"},
		"no address":        {[]byte{0, 128, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0}, "no external address"},
		"too short":         {ok[:11], errNotNATPMP.Error()},
		"another opcode":    {append([]byte{0, 129}, ok[2:]...), errNotNATPMP.Error()},
	} {
		if a, err := parseNATPMP(c.msg); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v %v, want an error with %q", name, a, err, c.want)
		}
	}
}

func TestGatewayLookups(t *testing.T) {
	routeGet := "   route to: default\ndestination: default\n       mask: default\n    gateway: 192.168.1.1\n  interface: en1\n"
	if a, err := gatewayFromRouteGet(routeGet); err != nil || a != netip.MustParseAddr("192.168.1.1") {
		t.Fatalf("route get: %v %v", a, err)
	}
	if _, err := gatewayFromRouteGet("    gateway: link#17\n"); err == nil {
		t.Fatal("an interface gateway counted as a router address")
	}
	proc := "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n" +
		"eth0\t0000A8C0\t00000000\t0001\t0\t0\t0\t00FFFFFF\n" +
		"eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\n"
	if a, err := gatewayFromProcRoute(proc); err != nil || a != netip.MustParseAddr("192.168.1.1") {
		t.Fatalf("/proc/net/route: %v %v", a, err)
	}
	if _, err := gatewayFromProcRoute(strings.Split(proc, "\n")[0]); err == nil {
		t.Fatal("no default route, yet a gateway")
	}
}
