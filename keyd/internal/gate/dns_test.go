package gate

import (
	"encoding/binary"
	"net/netip"
	"testing"
)

func query(id uint16, name string, qtype uint16) []byte {
	q := binary.BigEndian.AppendUint16(nil, id)
	q = append(q, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0)
	for _, label := range splitDots(name) {
		q = append(q, byte(len(label)))
		q = append(q, label...)
	}
	q = append(q, 0)
	q = binary.BigEndian.AppendUint16(q, qtype)
	return binary.BigEndian.AppendUint16(q, classIN)
}

func splitDots(name string) []string {
	var out []string
	start := 0
	for i := 0; i <= len(name); i++ {
		if i == len(name) || name[i] == '.' {
			out = append(out, name[start:i])
			start = i + 1
		}
	}
	return out
}

func rcode(t *testing.T, out []byte) (byte, uint16) {
	t.Helper()
	if len(out) < 12 || out[2]&0x80 == 0 {
		t.Fatalf("not a reply: %x", out)
	}
	return out[3] & 0x0f, binary.BigEndian.Uint16(out[6:8])
}

func TestAnswerGivesEachNameItsOwnPlaceholder(t *testing.T) {
	pool := NewPool()
	out, err := Answer(query(7, "Chat.Example.com", typeA), pool)
	if err != nil {
		t.Fatal(err)
	}
	if code, answers := rcode(t, out); code != rcodeOK || answers != 1 || binary.BigEndian.Uint16(out[0:2]) != 7 {
		t.Fatalf("reply %x", out)
	}
	a := netip.AddrFrom4([4]byte(out[len(out)-4:]))
	if !Placeholders.Contains(a) {
		t.Fatalf("address %s", a)
	}
	if name, ok := pool.Name(a); !ok || name != "chat.example.com" {
		t.Fatalf("pool name %q %v", name, ok)
	}
	again, _ := Answer(query(8, "chat.example.com", typeA), pool)
	if netip.AddrFrom4([4]byte(again[len(again)-4:])) != a {
		t.Fatal("a name got a second placeholder")
	}
	other, _ := Answer(query(9, "mail.example.com", typeA), pool)
	if netip.AddrFrom4([4]byte(other[len(other)-4:])) == a {
		t.Fatal("two names share a placeholder")
	}
}

func TestAnswerRefusesWhatKeydRefusesByName(t *testing.T) {
	pool := NewPool()
	for _, name := range []string{"localhost", "host.docker.internal", "printer.local", "nas.home.arpa", "keyd.ldot", "llm.ldot", "1.2.3.4", "0x7f.0x1", "a_b.example.com"} {
		out, err := Answer(query(1, name, typeA), pool)
		if err != nil {
			t.Fatal(err)
		}
		if code, answers := rcode(t, out); code != rcodeNotFound || answers != 0 {
			t.Errorf("%s: rcode %d answers %d", name, code, answers)
		}
	}
	if len(pool.byName) != 0 {
		t.Fatalf("placeholders given: %v", pool.byName)
	}
}

func TestAnswerHasNoDataForOtherTypes(t *testing.T) {
	for _, qtype := range []uint16{typeAAAA, 15, 16, 33, 65} {
		out, _ := Answer(query(1, "example.com", qtype), NewPool())
		if code, answers := rcode(t, out); code != rcodeOK || answers != 0 {
			t.Errorf("type %d: rcode %d answers %d", qtype, code, answers)
		}
	}
}

func TestAnswerRejectsMalformedQueries(t *testing.T) {
	if _, err := Answer([]byte{1, 2, 3}, NewPool()); err == nil {
		t.Fatal("short message answered")
	}
	reply := query(1, "example.com", typeA)
	reply[2] |= 0x80
	if _, err := Answer(reply, NewPool()); err == nil {
		t.Fatal("a reply was answered")
	}
	truncated := query(1, "example.com", typeA)
	if out, _ := Answer(truncated[:len(truncated)-3], NewPool()); out[3]&0x0f != rcodeFormat {
		t.Fatalf("truncated: %x", out)
	}
	update := query(1, "example.com", typeA)
	update[2] = 5 << 3
	if out, _ := Answer(update, NewPool()); out[3]&0x0f != rcodeNotImpl {
		t.Fatalf("update: %x", out)
	}
}

func TestThePoolReusesTheOldestSlotWhenFull(t *testing.T) {
	pool := NewPool()
	first := pool.Addr("first.example.com")
	pool.next = placeholderSlots
	if got := pool.Addr("wrapped.example.com"); got != first {
		t.Fatalf("wrapped to %s, want %s", got, first)
	}
	if _, ok := pool.byName["first.example.com"]; ok {
		t.Fatal("the evicted name kept its placeholder")
	}
	if name, _ := pool.Name(first); name != "wrapped.example.com" {
		t.Fatalf("slot names %q", name)
	}
	last := pool.Addr("x.example.com")
	pool.next = placeholderSlots - 1
	if a := pool.Addr("y.example.com"); a != netip.MustParseAddr("198.19.255.254") || last == a {
		t.Fatalf("last slot %s", a)
	}
}
