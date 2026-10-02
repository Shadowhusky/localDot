package main

import (
	"bytes"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/netguard"
)

// A router on loopback that answers NAT-PMP's external address request with 81.2.69.160.
func fakeRouter(t *testing.T) netguard.Discovery {
	t.Helper()
	pc, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pc.Close() })
	go func() {
		buf := make([]byte, 64)
		for {
			n, from, err := pc.ReadFrom(buf)
			if err != nil {
				return
			}
			if n == 2 {
				pc.WriteTo([]byte{0, 128, 0, 0, 0, 0, 0, 9, 81, 2, 69, 160}, from)
			}
		}
	}()
	return netguard.Discovery{
		Router:     func() (netip.Addr, error) { return netip.MustParseAddr("127.0.0.1"), nil },
		NATPMPPort: pc.LocalAddr().(*net.UDPAddr).Port,
		Timeout:    time.Second,
	}
}

func TestStartLearnsThePublicAddressItDeniesAndReportsTheGuard(t *testing.T) {
	d, err := start(Config{Home: shortHome(t), Vault: "memory", Discovery: fakeRouter(t)})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	admin := socketClient(d.Socket)
	deadline := time.Now().Add(3 * time.Second)
	var hairpin map[string]any
	for time.Now().Before(deadline) {
		_, status := adminCall(t, admin, "GET", "/v1/status", nil)
		hairpin, _ = status["hairpin"].(map[string]any)
		if hairpin["state"] == "active" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if hairpin["state"] != "active" || hairpin["source"] != "nat-pmp" || hairpin["addresses"] != float64(1) {
		t.Fatalf("hairpin %v", hairpin)
	}
	if got := d.public.Addrs(); len(got) != 1 || got[0].String() != "81.2.69.160" {
		t.Fatalf("learned %v", got)
	}
}

func TestStartWithDiscoveryOffSaysTheGuardIsOff(t *testing.T) {
	d, err := start(Config{Home: shortHome(t), Vault: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	_, status := adminCall(t, socketClient(d.Socket), "GET", "/v1/status", nil)
	if hairpin, _ := status["hairpin"].(map[string]any); hairpin["state"] != "off" {
		t.Fatalf("hairpin %v", status["hairpin"])
	}
	var out bytes.Buffer
	if code := run([]string{"-natpmp", "maybe"}, &out); code != 2 {
		t.Fatalf("-natpmp maybe: exit %d", code)
	}
}
