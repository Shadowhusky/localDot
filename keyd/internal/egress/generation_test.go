package egress

import (
	"errors"
	"io"
	"net"
	"testing"
	"time"
)

// A CONNECT that captured a generation before the kill switch can hand its tunnel to track after.
// The tunnel must close then, not outlive the switch.
func TestAConnectionTrackedAfterTheKillSwitchIsClosed(t *testing.T) {
	g := newGeneration(Deps{})
	g.stop()
	conn, peer := net.Pipe()
	defer peer.Close()
	g.track(conn)()
	peer.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := peer.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatalf("a connection tracked after the kill switch is still open: %v", err)
	}
}
