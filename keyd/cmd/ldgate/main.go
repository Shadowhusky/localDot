// Command ldgate runs in a desktop cell's gate beside its relays: it answers the cell's DNS with
// placeholders and hands every connection the gate captured to keyd as a CONNECT. The gate's
// entrypoint redirects the TCP and DNS arriving on the desktop's link here, then drops every
// privilege before starting it.
package main

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/gate"
)

const (
	// linkAddr is the gate's end of the desktop's link (cells/gate/link.sh).
	linkAddr    = "192.0.0.1"
	capturePort = 3130
	dnsPort     = 5353
	// keyd holds a connection for the user for at most two minutes; its answer comes within this.
	answerWithin = 3 * time.Minute
)

var tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "ldgate: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	self, err := netip.ParseAddr(os.Getenv("LD_INTERNAL_ADDR"))
	if err != nil || !self.Is4() {
		return fmt.Errorf("LD_INTERNAL_ADDR must be the gate's IPv4 address on the cell network")
	}
	port, err := strconv.Atoi(os.Getenv("LD_KEYD_PORT"))
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("LD_KEYD_PORT must be keyd's listener port")
	}
	token := os.Getenv("LD_CAPTURE_TOKEN")
	if !tokenPattern.MatchString(token) {
		return fmt.Errorf("LD_CAPTURE_TOKEN must be 43 base64url characters")
	}
	pool := gate.NewPool()
	at := func(host string, p int) string { return net.JoinHostPort(host, strconv.Itoa(p)) }
	captured, err := net.Listen("tcp4", at(linkAddr, capturePort))
	if err != nil {
		return err
	}
	// The desktop's resolver asks the gate's address on the cell network; a program asking any
	// other server is redirected from the link.
	failed := make(chan error, 5)
	for _, host := range []string{self.String(), linkAddr} {
		udp, err := net.ListenPacket("udp4", at(host, dnsPort))
		if err != nil {
			return err
		}
		tcp, err := net.Listen("tcp4", at(host, dnsPort))
		if err != nil {
			return err
		}
		go func() { failed <- gate.ServeUDP(udp, pool) }()
		go func() { failed <- gate.ServeTCP(tcp, pool) }()
	}
	var d net.Dialer
	capture := &gate.Capture{
		Keyd: net.JoinHostPort("host.docker.internal", strconv.Itoa(port)), Token: token,
		Self: netip.MustParseAddr(linkAddr), Pool: pool, Original: gate.OriginalDst, Dial: d.DialContext,
		Answer: answerWithin, Limit: 256,
	}
	go func() { failed <- capture.Serve(captured) }()
	fmt.Fprintf(os.Stderr, "ldgate: capture %s, dns %s and %s\n", at(linkAddr, capturePort), at(self.String(), dnsPort), at(linkAddr, dnsPort))
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	select {
	case <-ctx.Done():
		return nil
	case err := <-failed:
		return err
	}
}
