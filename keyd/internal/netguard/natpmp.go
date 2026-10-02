package netguard

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const natpmpPort = 5351

// askRouter asks the default gateway for its external IPv4 address: NAT-PMP's request 0 (RFC
// 6886), resent after 250 ms and then twice as long until the timeout. The socket is connected,
// so only the gateway's answers are read.
func askRouter(d Discovery) (netip.Addr, error) {
	router, err := d.Router()
	if err != nil {
		return netip.Addr{}, fmt.Errorf("nat-pmp: %w", err)
	}
	if err := d.err(); err != nil {
		return netip.Addr{}, err
	}
	port := d.NATPMPPort
	if port == 0 {
		port = natpmpPort
	}
	ctx, cancel := context.WithTimeout(d.context(), d.Timeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "udp4", net.JoinHostPort(router.String(), strconv.Itoa(port)))
	if err != nil {
		return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
	}
	defer conn.Close()
	defer context.AfterFunc(ctx, func() { conn.Close() })()
	deadline := time.Now().Add(d.Timeout)
	buf := make([]byte, 64)
	for wait := 250 * time.Millisecond; ; wait *= 2 {
		if _, err := conn.Write([]byte{0, 0}); err != nil {
			return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
		}
		next := time.Now().Add(wait)
		if next.After(deadline) {
			next = deadline
		}
		if err := conn.SetReadDeadline(next); err != nil {
			return netip.Addr{}, err
		}
		for {
			n, err := conn.Read(buf)
			if err != nil {
				var timeout net.Error
				if errors.As(err, &timeout) && timeout.Timeout() && time.Now().Before(deadline) {
					break
				}
				return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
			}
			a, err := parseNATPMP(buf[:n])
			if errors.Is(err, errNotNATPMP) {
				continue
			}
			if err != nil {
				return netip.Addr{}, fmt.Errorf("nat-pmp %s: %w", router, err)
			}
			return a, nil
		}
	}
}

var errNotNATPMP = errors.New("not a NAT-PMP external address answer")

// parseNATPMP reads an external address response: version 0, opcode 128, a result code, the
// seconds since the router's epoch and the address. A PCP-only router answers version 2.
func parseNATPMP(msg []byte) (netip.Addr, error) {
	if len(msg) >= 2 && msg[0] == 2 {
		return netip.Addr{}, errors.New("the router speaks PCP only")
	}
	if len(msg) < 12 || msg[0] != 0 || msg[1] != 128 {
		return netip.Addr{}, errNotNATPMP
	}
	if code := binary.BigEndian.Uint16(msg[2:4]); code != 0 {
		return netip.Addr{}, fmt.Errorf("the router refused with result code %d", code)
	}
	a := netip.AddrFrom4([4]byte(msg[8:12]))
	if a.IsUnspecified() {
		return netip.Addr{}, errors.New("the router has no external address")
	}
	return a, nil
}

// DefaultGateway finds the IPv4 default gateway: macOS's `route -n get default`, Linux's
// /proc/net/route.
func DefaultGateway() (netip.Addr, error) {
	switch runtime.GOOS {
	case "darwin":
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, "/sbin/route", "-n", "get", "default").Output()
		if err != nil {
			return netip.Addr{}, fmt.Errorf("route -n get default: %w", err)
		}
		return gatewayFromRouteGet(string(out))
	case "linux":
		text, err := os.ReadFile("/proc/net/route")
		if err != nil {
			return netip.Addr{}, err
		}
		return gatewayFromProcRoute(string(text))
	}
	return netip.Addr{}, fmt.Errorf("no default gateway lookup on %s", runtime.GOOS)
}

func gatewayFromRouteGet(out string) (netip.Addr, error) {
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || key != "gateway" {
			continue
		}
		a, err := netip.ParseAddr(strings.TrimSpace(value))
		if err == nil && a.Is4() {
			return a, nil
		}
	}
	return netip.Addr{}, errors.New("no IPv4 default gateway")
}

// gatewayFromProcRoute reads the default route's gateway, which /proc/net/route prints as
// little-endian hex.
func gatewayFromProcRoute(text string) (netip.Addr, error) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 || f[1] != "00000000" {
			continue
		}
		v, err := strconv.ParseUint(f[2], 16, 32)
		if err != nil || v == 0 {
			continue
		}
		return netip.AddrFrom4([4]byte{byte(v), byte(v >> 8), byte(v >> 16), byte(v >> 24)}), nil
	}
	return netip.Addr{}, errors.New("no IPv4 default gateway")
}
