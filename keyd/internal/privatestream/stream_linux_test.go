package privatestream

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"testing"
)

// An abstract socket has no file, yet any process in the network namespace can connect to it.
func TestRejectsAbstractSockets(t *testing.T) {
	nonce := make([]byte, 8)
	rand.Read(nonce)
	for _, name := range []string{"@localdot-test-" + hex.EncodeToString(nonce), "@"} {
		listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: name, Net: "unix"})
		if err != nil {
			t.Logf("%q: %v", name, err)
			continue
		}
		defer listener.Close()
		client, err := net.DialUnix("unix", nil, listener.Addr().(*net.UnixAddr))
		if err != nil {
			t.Fatal(err)
		}
		defer client.Close()
		server, err := listener.AcceptUnix()
		if err != nil {
			t.Fatal(err)
		}
		defer server.Close()
		for _, conn := range []*net.UnixConn{client, server} {
			file, err := conn.File()
			if err != nil {
				t.Fatal(err)
			}
			if stream, err := Duplicate(file); err == nil || stream != nil {
				t.Fatalf("%q: an abstract socket was accepted", name)
			}
			file.Close()
		}
	}
}
