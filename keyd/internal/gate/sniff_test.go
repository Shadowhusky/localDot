package gate

import (
	"crypto/tls"
	"net"
	"testing"
	"time"
)

// clientHello captures the first flight of a real TLS client for name.
func clientHello(t *testing.T, name string) []byte {
	t.Helper()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	go tls.Client(a, &tls.Config{ServerName: name, InsecureSkipVerify: true}).Handshake()
	b.SetDeadline(time.Now().Add(2 * time.Second))
	var out []byte
	buf := make([]byte, 4096)
	for {
		n, err := b.Read(buf)
		out = append(out, buf[:n]...)
		if _, more := Named(out); !more || err != nil {
			return out
		}
	}
}

func TestNamedReadsTheServerNameOfAClientHelloEvenWhenItArrivesInPieces(t *testing.T) {
	hello := clientHello(t, "long.example.com")
	if name, more := Named(hello); name != "long.example.com" || more {
		t.Fatalf("%q %v", name, more)
	}
	for _, cut := range []int{1, 4, 5, 100, len(hello) - 1} {
		if name, more := Named(hello[:cut]); name != "" || !more {
			t.Fatalf("cut at %d: %q %v", cut, name, more)
		}
	}
}

func TestNamedReadsAnHTTPHostAndGivesUpOnAnythingElse(t *testing.T) {
	for _, tc := range []struct {
		in   string
		name string
		more bool
	}{
		{"GET / HTTP/1.1\r\nHost: a.example.com:8080\r\n\r\n", "a.example.com", false},
		{"POST /x HTTP/1.1\r\nhost:b.example.com\r\nContent-Length: 2\r\n\r\nhi", "b.example.com", false},
		{"GET / HTTP/1.1\r\nAccept: */*\r\nHo", "", true},
		{"GE", "", true},
		{"GET / HTTP/1.1\r\n\r\n", "", false},
		{"\x16\xf1\x04\x00\x10binary", "", false},
		{"SSH-2.0-OpenSSH_9.6\r\n", "", false},
		{"", "", true},
	} {
		if name, more := Named([]byte(tc.in)); name != tc.name || more != tc.more {
			t.Fatalf("%q: %q %v", tc.in, name, more)
		}
	}
}
