// Package gate is the capture side of a desktop cell's gate: programs in the cell that ignore the
// proxy resolve names through Resolver, which answers each name with a placeholder address and
// asks nobody, and connect through Capture, which turns the placeholder back into the name and
// asks keyd for a CONNECT to it. Only keyd resolves a real address, checks it and dials it.
package gate

import (
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"strings"
	"sync"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

// Placeholders is benchmarking space (RFC 2544): no real host has one of these, and netguard
// refuses them, so a placeholder can only ever mean the name it was given for.
var Placeholders = netip.MustParsePrefix("198.18.0.0/15")

// placeholderSlots skips the range's first and last address.
const placeholderSlots = 1<<17 - 2

// Pool gives each name one placeholder for as long as the gate runs. When every slot is taken it
// starts again from the first, so the oldest name loses its address; a program still holding
// that address then reaches the newer name, which is also what keyd is asked about.
type Pool struct {
	mu     sync.Mutex
	byName map[string]netip.Addr
	byAddr map[netip.Addr]string
	next   uint32
}

func NewPool() *Pool {
	return &Pool{byName: map[string]netip.Addr{}, byAddr: map[netip.Addr]string{}}
}

func (p *Pool) Addr(name string) netip.Addr {
	p.mu.Lock()
	defer p.mu.Unlock()
	if a, ok := p.byName[name]; ok {
		return a
	}
	base := binary.BigEndian.Uint32(Placeholders.Addr().AsSlice())
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], base+1+p.next%placeholderSlots)
	p.next++
	a := netip.AddrFrom4(b)
	if old, ok := p.byAddr[a]; ok {
		delete(p.byName, old)
	}
	p.byName[name], p.byAddr[a] = a, name
	return a
}

func (p *Pool) Name(a netip.Addr) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	name, ok := p.byAddr[a.Unmap()]
	return name, ok
}

const (
	typeA    = 1
	typeAAAA = 28
	classIN  = 1
	ttl      = 60

	rcodeOK       = 0
	rcodeFormat   = 1
	rcodeNotFound = 3
	rcodeNotImpl  = 4
)

var errNotQuery = errors.New("gate: not a DNS query")

// Answer builds the reply to one DNS query: a placeholder for an A question about a name keyd
// could be asked about, no data for its other types, and no such name for anything keyd refuses
// by name (local and reserved names, addresses written as names). Nothing is forwarded, so no
// name the cell looks up leaves the gate as a DNS query.
func Answer(query []byte, pool *Pool) ([]byte, error) {
	if len(query) < 12 || query[2]&0x80 != 0 {
		return nil, errNotQuery
	}
	opcode := (query[2] >> 3) & 0x0f
	header := func(rcode byte, answers uint16, question []byte) []byte {
		out := make([]byte, 12, 12+len(question)+16)
		copy(out[0:2], query[0:2])
		out[2] = 0x80 | query[2]&0x79 // QR, the query's opcode and RD
		out[3] = 0x80 | rcode         // RA
		if question != nil {
			binary.BigEndian.PutUint16(out[4:6], 1)
		}
		binary.BigEndian.PutUint16(out[6:8], answers)
		return append(out, question...)
	}
	if opcode != 0 {
		return header(rcodeNotImpl, 0, nil), nil
	}
	if binary.BigEndian.Uint16(query[4:6]) != 1 {
		return header(rcodeFormat, 0, nil), nil
	}
	name, end, ok := readName(query, 12)
	if !ok || end+4 > len(query) {
		return header(rcodeFormat, 0, nil), nil
	}
	question := query[12 : end+4]
	qtype := binary.BigEndian.Uint16(query[end : end+2])
	qclass := binary.BigEndian.Uint16(query[end+2 : end+4])
	host, ok := Reachable(name)
	if !ok || qclass != classIN {
		return header(rcodeNotFound, 0, question), nil
	}
	if qtype != typeA {
		return header(rcodeOK, 0, question), nil
	}
	a := pool.Addr(host).As4()
	out := header(rcodeOK, 1, question)
	out = append(out, 0xc0, 0x0c) // the question's name
	out = binary.BigEndian.AppendUint16(out, typeA)
	out = binary.BigEndian.AppendUint16(out, classIN)
	out = binary.BigEndian.AppendUint32(out, ttl)
	out = binary.BigEndian.AppendUint16(out, 4)
	return append(out, a[:]...), nil
}

// Reachable normalises a looked-up name and says whether keyd would take it by name.
func Reachable(name string) (string, bool) {
	t, reason := policy.ParseHostPort(net.JoinHostPort(name, "443"), 0)
	if reason != "" || policy.Denied(t.Host) {
		return "", false
	}
	return t.Host, true
}

// readName reads an uncompressed question name: labels of printable ASCII, 253 bytes at most.
func readName(msg []byte, i int) (string, int, bool) {
	var labels []string
	for total := 0; i < len(msg); {
		n := int(msg[i])
		i++
		if n == 0 {
			return strings.Join(labels, "."), i, len(labels) > 0
		}
		if n > 63 || i+n > len(msg) {
			return "", 0, false
		}
		label := msg[i : i+n]
		for _, c := range label {
			if c <= ' ' || c > '~' || c == '.' {
				return "", 0, false
			}
		}
		if total += n + 1; total > 254 {
			return "", 0, false
		}
		labels = append(labels, string(label))
		i += n
	}
	return "", 0, false
}
