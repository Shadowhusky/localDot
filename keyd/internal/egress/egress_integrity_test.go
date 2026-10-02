package egress

import (
	"context"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/policy"
)

// recordingDialer notes every address egress asks for, then dials through the world.
type recordingDialer struct {
	next Dialer
	mu   sync.Mutex
	seen []string
}

func (d *recordingDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	d.mu.Lock()
	d.seen = append(d.seen, address)
	d.mu.Unlock()
	return d.next.DialContext(ctx, network, address)
}

func (d *recordingDialer) addresses() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.seen...)
}

// recordingCell opens a cell whose dials are recorded.
func (w *world) recordingCell(id string, role policy.Role) (*Cell, *recordingDialer) {
	w.t.Helper()
	p, err := policy.ForRole(role)
	if err != nil {
		w.t.Fatal(err)
	}
	rd := &recordingDialer{next: portMap{w}}
	deps := w.deps()
	deps.Dialer = rd
	c, err := Open(Config{CellID: id, Policy: p, Token: testToken}, deps)
	if err != nil {
		w.t.Fatal(err)
	}
	w.t.Cleanup(func() { c.Close() })
	return c, rd
}

// A relative name would go through the resolver's search domains; keyd dials the absolute name,
// while the upstream still sees the name without the dot.
func TestPlainHTTPDialsTheAbsoluteName(t *testing.T) {
	w := newWorld(t)
	seen := make(chan string, 1)
	w.plainUpstream("ports.example.test", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		seen <- r.Host
		io.WriteString(rw, "ok")
	}))
	c, rd := w.recordingCell("c1", policy.Desktop)
	for _, u := range []string{"http://ports.example.test/", "http://ports.example.test./", "http://PORTS.example.test:80/"} {
		resp, body := get(t, w.client(c), u)
		if resp.StatusCode != 200 || body != "ok" {
			t.Fatalf("%s: %d %q", u, resp.StatusCode, body)
		}
		if host := <-seen; host != "ports.example.test" {
			t.Fatalf("%s: upstream saw Host %q", u, host)
		}
	}
	for _, a := range rd.addresses() {
		if a != "ports.example.test.:80" {
			t.Fatalf("dialled %q, want the absolute name", a)
		}
	}
	if len(rd.addresses()) == 0 {
		t.Fatal("nothing dialled")
	}
}
