package netguard

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"sync"
	"time"
)

// DefaultSTUN uses Cloudflare, asked only when the router gives no public answer.
const DefaultSTUN = "stun.cloudflare.com:3478"

// maxPublic bounds the addresses kept: a dynamic address that changes daily adds one a day.
const maxPublic = 16

// quickRetries is how many failed rounds in a row Keep follows with a quick retry; after that it
// asks at the long interval (or when the network changes), so an unknown guard does not ask a STUN
// server every 30 s for as long as it lasts.
const quickRetries = 4

// Public holds the addresses this Mac's traffic leaves its network with. A home router answers on
// its public address from inside the network (hairpin NAT), often with its admin page or with a
// port it forwards to the LAN, so keyd denies those addresses like the Mac's own. Addresses once
// learned stay: an old public address may still route back here.
type Public struct {
	mu     sync.RWMutex
	addrs  []netip.Addr
	status PublicStatus
	// graced: the guard stayed active through one failed round; the next one makes it unknown.
	graced bool
}

// PublicStatus is the hairpin guard as keyd's /v1/status reports it: "active" while the last
// round learned the public address, "unknown" while none could, "off" with discovery turned off.
type PublicStatus struct {
	State     string `json:"state"`
	Source    string `json:"source,omitempty"`
	Addresses int    `json:"addresses"`
	CheckedAt string `json:"checkedAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Discovery says where the public address comes from: the router first (NAT-PMP, so no third
// party learns anything), then STUN, then optional HTTPS when UDP is unavailable.
// Nil/empty sources are disabled.
type Discovery struct {
	Router     func() (netip.Addr, error)
	NATPMPPort int
	STUN       string
	HTTPS      func(context.Context, time.Duration) (netip.Addr, error)
	Timeout    time.Duration
	ctx        context.Context
	stop       <-chan struct{}
}

func (d Discovery) context() context.Context {
	if d.ctx != nil {
		return d.ctx
	}
	return context.Background()
}

func (d Discovery) err() error {
	select {
	case <-d.stop:
		return context.Canceled
	default:
		return d.context().Err()
	}
}

// Off says whether all sources are turned off.
func (d Discovery) Off() bool { return d.Router == nil && d.STUN == "" && d.HTTPS == nil }

func (p *Public) Addrs() []netip.Addr {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return slices.Clone(p.addrs)
}

func (p *Public) Status() PublicStatus {
	p.mu.RLock()
	defer p.mu.RUnlock()
	st := p.status
	if st.State == "" {
		st.State = "unknown"
	}
	st.Addresses = len(p.addrs)
	return st
}

func (p *Public) add(a netip.Addr) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if slices.Contains(p.addrs, a) {
		return
	}
	p.addrs = append(p.addrs, a)
	if len(p.addrs) > maxPublic {
		p.addrs = slices.Clone(p.addrs[len(p.addrs)-maxPublic:])
	}
}

func (p *Public) record(state, source string, err error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if state == "unknown" && p.status.State == "active" && !p.graced {
		// One lost round is not a new network: the guard stays active (it still denies what it
		// learned) and says why; the next failed round makes it unknown.
		p.graced = true
		p.status.Error = "the last round failed"
		if err != nil {
			p.status.Error = clip(p.status.Error + ": " + err.Error())
		}
		return
	}
	p.graced = false
	p.status = PublicStatus{State: state, Source: source}
	if state != "off" {
		p.status.CheckedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if err != nil {
		p.status.Error = clip(err.Error())
	}
}

func clip(msg string) string {
	if len(msg) > 300 {
		return msg[:300]
	}
	return msg
}

// Learn asks the router, and asks STUN only when the router has no public answer: it does not
// speak NAT-PMP (PCP-only routers answer with a version error), or it sits behind another NAT,
// whose address it then reports (private or shared space, which the guard denies anyway).
func (p *Public) Learn(d Discovery) error {
	if err := d.err(); err != nil {
		return err
	}
	if d.Off() {
		p.record("off", "", nil)
		return nil
	}
	if d.Timeout == 0 {
		d.Timeout = 3 * time.Second
	}
	var errs []error
	if d.Router != nil {
		a, err := askRouter(d)
		if stopped := d.err(); stopped != nil {
			return stopped
		}
		if err == nil && publicIPv4(a) {
			p.add(a)
			p.record("active", "nat-pmp", nil)
			return nil
		}
		if err == nil {
			p.add(a)
			err = fmt.Errorf("nat-pmp: the router's address %s is behind another NAT", a)
		}
		errs = append(errs, err)
	}
	if d.STUN != "" {
		a, err := stunAddr(d.context(), d.STUN, d.Timeout)
		if stopped := d.err(); stopped != nil {
			return stopped
		}
		if err == nil && publicIPv4(a) {
			p.add(a)
			p.record("active", "stun", nil)
			return nil
		}
		if err == nil {
			err = fmt.Errorf("stun %s: answered %s, which is not a public address", d.STUN, a)
		}
		errs = append(errs, err)
	}
	if d.HTTPS != nil {
		a, err := d.HTTPS(d.context(), d.Timeout)
		if stopped := d.err(); stopped != nil {
			return stopped
		}
		if err == nil && publicIPv4(a) {
			p.add(a)
			p.record("active", "https", nil)
			return nil
		}
		if err == nil {
			err = fmt.Errorf("HTTPS discovery returned a non-public IPv4 address")
		}
		errs = append(errs, err)
	}
	err := errors.Join(errs...)
	p.record("unknown", "", err)
	return err
}

// Keep learns at once, then keeps the address fresh until stop is closed:
//   - while it is known, it asks again every `every`, and at once when the default gateway changes
//     (another network), which it looks up every `retry` (only with the router as a source);
//   - while it is not, it asks every `retry`, and every `every` after quickRetries failed rounds in
//     a row, so a network that never answers is not asked every 30 s for as long as that lasts.
//
// A failed round goes to logf and to the status.
func (p *Public) Keep(d Discovery, every, retry time.Duration, stop <-chan struct{}, logf func(string, ...any)) {
	d.stop = stop
	if d.err() != nil {
		return
	}
	ctx, cancel := context.WithCancel(d.context())
	defer cancel()
	d.ctx = ctx
	go func() {
		select {
		case <-stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	gateway := func() netip.Addr {
		if d.Router == nil {
			return netip.Addr{}
		}
		a, _ := d.Router()
		return a
	}
	var (
		failed int
		seen   netip.Addr
		next   time.Time
	)
	learn := func() {
		if d.err() != nil {
			return
		}
		current := gateway()
		if d.err() != nil {
			return
		}
		if current != seen && seen.IsValid() {
			// A different network has no known public address yet. The one-round
			// grace only applies to a lost response on the same network.
			p.mu.Lock()
			p.status = PublicStatus{State: "unknown"}
			p.graced = false
			p.mu.Unlock()
		}
		seen = current
		wait := every
		if err := p.Learn(d); err != nil {
			if d.err() != nil {
				return
			}
			failed++
			if failed < quickRetries {
				wait = retry
			}
			logf("keyd: no answer for the public address, which hairpin NAT needs denied; asking again in %s: %v", wait, err)
		} else {
			failed = 0
		}
		next = time.Now().Add(wait)
	}
	learn()
	tick := time.NewTicker(retry)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if d.err() != nil {
			return
		}
		if !time.Now().Before(next) || gateway() != seen {
			learn()
		}
	}
}

// WithPublic adds the learned addresses to own, so Check denies them as the Mac's own.
func WithPublic(own func() ([]netip.Prefix, error), p *Public) func() ([]netip.Prefix, error) {
	return func() ([]netip.Prefix, error) {
		prefixes, err := own()
		for _, a := range p.Addrs() {
			prefixes = append(prefixes, netip.PrefixFrom(a, a.BitLen()))
		}
		return prefixes, err
	}
}

// publicIPv4 says whether the internet routes a: an answer in private, shared or special space
// comes from a router behind another NAT.
func publicIPv4(a netip.Addr) bool {
	a = a.Unmap()
	if !a.Is4() {
		return false
	}
	for _, s := range static {
		if s.prefix.Contains(a) {
			return false
		}
	}
	return true
}

const (
	stunBindingRequest   = 0x0001
	stunBindingSuccess   = 0x0101
	stunMagicCookie      = 0x2112A442
	stunMappedAddress    = 0x0001
	stunXorMappedAddress = 0x0020
)

// stunAddr sends one Binding request (RFC 8489) over UDP/IPv4 and returns the mapped address.
// Datagrams that are not the answer to this request are ignored until the deadline.
func stunAddr(parent context.Context, server string, timeout time.Duration) (netip.Addr, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "udp4", server)
	if err != nil {
		return netip.Addr{}, fmt.Errorf("stun %s: %w", server, err)
	}
	defer conn.Close()
	defer context.AfterFunc(ctx, func() { conn.Close() })()
	if err := conn.SetDeadline(time.Now().Add(timeout)); err != nil {
		return netip.Addr{}, err
	}
	req := make([]byte, 20)
	binary.BigEndian.PutUint16(req[0:2], stunBindingRequest)
	binary.BigEndian.PutUint32(req[4:8], stunMagicCookie)
	if _, err := rand.Read(req[8:20]); err != nil {
		return netip.Addr{}, err
	}
	if _, err := conn.Write(req); err != nil {
		return netip.Addr{}, fmt.Errorf("stun %s: %w", server, err)
	}
	buf := make([]byte, 1500)
	for {
		n, err := conn.Read(buf)
		if err != nil {
			return netip.Addr{}, fmt.Errorf("stun %s: %w", server, err)
		}
		if a, err := parseBindingSuccess(buf[:n], req[8:20]); err == nil {
			return a, nil
		}
	}
}

// parseBindingSuccess reads the mapped address from a Binding success response to the request
// with transaction ID txid; XOR-MAPPED-ADDRESS wins over the older MAPPED-ADDRESS.
func parseBindingSuccess(msg, txid []byte) (netip.Addr, error) {
	if len(msg) < 20 || binary.BigEndian.Uint16(msg[0:2]) != stunBindingSuccess ||
		binary.BigEndian.Uint32(msg[4:8]) != stunMagicCookie || !bytes.Equal(msg[8:20], txid) {
		return netip.Addr{}, errors.New("stun: not the answer to this request")
	}
	length := int(binary.BigEndian.Uint16(msg[2:4]))
	if length%4 != 0 || 20+length > len(msg) {
		return netip.Addr{}, errors.New("stun: bad message length")
	}
	key := msg[4:20]
	var mapped netip.Addr
	for attrs := msg[20 : 20+length]; len(attrs) >= 4; {
		typ := binary.BigEndian.Uint16(attrs[0:2])
		n := int(binary.BigEndian.Uint16(attrs[2:4]))
		if 4+n > len(attrs) {
			return netip.Addr{}, errors.New("stun: truncated attribute")
		}
		switch typ {
		case stunXorMappedAddress:
			if a, ok := stunAddress(attrs[4:4+n], key); ok {
				return a, nil
			}
		case stunMappedAddress:
			if a, ok := stunAddress(attrs[4:4+n], nil); ok {
				mapped = a
			}
		}
		next := 4 + n + (4-n%4)%4
		if next > len(attrs) {
			break
		}
		attrs = attrs[next:]
	}
	if mapped.IsValid() {
		return mapped, nil
	}
	return netip.Addr{}, errors.New("stun: no mapped address")
}

// stunAddress decodes a MAPPED-ADDRESS value, or an XOR-MAPPED-ADDRESS one when key (the magic
// cookie and the transaction ID) is given.
func stunAddress(val, key []byte) (netip.Addr, bool) {
	if len(val) < 4 {
		return netip.Addr{}, false
	}
	var raw []byte
	switch {
	case val[1] == 0x01 && len(val) == 8:
		raw = slices.Clone(val[4:8])
	case val[1] == 0x02 && len(val) == 20:
		raw = slices.Clone(val[4:20])
	default:
		return netip.Addr{}, false
	}
	for i := range raw {
		if key != nil {
			raw[i] ^= key[i]
		}
	}
	a, ok := netip.AddrFromSlice(raw)
	return a.Unmap(), ok
}
