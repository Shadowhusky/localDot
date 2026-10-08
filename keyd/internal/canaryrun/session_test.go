package canaryrun

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/canary"
	"github.com/shadowhusky/localdot/keyd/internal/egress"
)

type fakeManager struct {
	open        func(egress.OpenRequest) (egress.Opened, error)
	closed, all int
	closeErr    error
}

func (m *fakeManager) Open(r egress.OpenRequest) (egress.Opened, error) { return m.open(r) }
func (m *fakeManager) Close(string) error                               { m.closed++; return m.closeErr }
func (m *fakeManager) CloseAll()                                        { m.all++ }
func config(t *testing.T) Config {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if os.Chmod(dir, 0700) != nil {
		t.Fatal("private fixture failed")
	}
	return Config{Directory: dir, CellID: "01JXYZ00000000000000000001", RunID: "01234567-89ab-4cde-8fab-0123456789ab"}
}
func opened(id string) egress.Opened {
	return egress.Opened{CellID: id, Port: 49123, ProxyToken: strings.Repeat("t", 43), CACertPEM: "synthetic-ca", Surrogates: map[string]string{"diagnostic": "synthetic-surrogate"}}
}
func TestSessionUsesOnlyItsGeneratedKeyAndIsolatedTransport(t *testing.T) {
	c := config(t)
	m := &fakeManager{}
	var captured egress.ManagerDeps
	m.open = func(req egress.OpenRequest) (egress.Opened, error) {
		if req.CellID != c.CellID || req.Role != "desktop" || req.Port != 0 || len(req.Secrets) != 1 || req.Secrets[0] != "diagnostic" {
			t.Fatal("wrong scope")
		}
		return opened(req.CellID), nil
	}
	s, err := start(context.Background(), c, func(d egress.ManagerDeps) manager { captured = d; return m })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	ready := s.Ready()
	records := captured.Vault.Records()
	if len(records) != 1 || records[0].ID != "diagnostic" || len(records[0].Hosts) != 1 || records[0].Hosts[0] != canary.Host || len(records[0].Methods) != 1 || records[0].Methods[0] != "GET" || len(records[0].Paths) != 1 {
		t.Fatal("unexpected secret scope")
	}
	value, err := captured.Vault.Value("diagnostic")
	if err != nil || string(value) != ready.SyntheticSecret || !strings.HasPrefix(string(value), "canary-") {
		t.Fatal("not generated synthetic key")
	}
	if captured.Local != nil || captured.LocalDialer != nil || captured.Ports != (egress.PortRange{}) {
		t.Fatal("ordinary network capability supplied")
	}
	if _, ok := captured.Dialer.(*canary.Echo); !ok {
		t.Fatal("unexpected upstream dialer")
	}
	if ready.RunID != c.RunID || ready.CellID != c.CellID || ready.Port != 49123 || !strings.HasPrefix(ready.URL, "https://"+canary.Host+"/v1/canary/") {
		t.Fatal("bad ready identity")
	}
	closed, err := s.Close()
	if err != nil || !closed.GatewayClosed || !closed.Echo.Closed || closed.Echo.Active != 0 {
		t.Fatal("retirement not confirmed")
	}
	if _, err := os.Stat(filepath.Join(c.Directory, "gateway", "audit.jsonl")); err != nil {
		t.Fatal("artifacts discarded before parent scan")
	}
	s.Close()
	if m.closed != 1 || m.all != 1 {
		t.Fatal("repeated cleanup")
	}
	if captured.Audit.Err() == nil {
		t.Fatal("audit still advertises readiness")
	}
}
func TestSessionRefusesUnsafeOrReusedDirectoriesBeforeOpening(t *testing.T) {
	for _, fault := range []string{"relative", "symlink", "public", "nonempty", "file", "cell", "run", "cancelled"} {
		t.Run(fault, func(t *testing.T) {
			c := config(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "relative":
				c.Directory = "relative"
			case "symlink":
				path := filepath.Join(config(t).Directory, "link")
				if os.Symlink(c.Directory, path) != nil {
					t.Fatal("fixture link")
				}
				c.Directory = path
			case "public":
				os.Chmod(c.Directory, 0755)
			case "nonempty":
				os.WriteFile(filepath.Join(c.Directory, "preserve"), []byte("fixture"), 0600)
			case "file":
				path := filepath.Join(c.Directory, "file")
				os.WriteFile(path, []byte("fixture"), 0600)
				c.Directory = path
			case "cell":
				c.CellID = "../invalid"
			case "run":
				c.RunID = "invalid"
			case "cancelled":
				cancel()
			}
			called := false
			_, err := start(ctx, c, func(egress.ManagerDeps) manager { called = true; return nil })
			if err == nil || called {
				t.Fatal("invalid scope reached gateway")
			}
		})
	}
}
func TestSessionStartupUncertaintyRetiresEveryOwner(t *testing.T) {
	for _, fault := range []string{"open-error", "cancelled-after-open", "wrong-cell", "wrong-port", "no-surrogate"} {
		t.Run(fault, func(t *testing.T) {
			c := config(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			m := &fakeManager{}
			var d egress.ManagerDeps
			m.open = func(req egress.OpenRequest) (egress.Opened, error) {
				r := opened(req.CellID)
				switch fault {
				case "open-error":
					return r, errors.New("private failure")
				case "cancelled-after-open":
					cancel()
				case "wrong-cell":
					r.CellID = "another"
				case "wrong-port":
					r.Port = 80
				case "no-surrogate":
					r.Surrogates = nil
				}
				return r, nil
			}
			s, err := start(ctx, c, func(input egress.ManagerDeps) manager { d = input; return m })
			if s != nil || err == nil || err.Error() != refused.Error() || m.closed != 1 || m.all != 1 || !d.Dialer.(*canary.Echo).Receipt().Closed || d.Audit.Err() == nil {
				t.Fatal("uncertain startup escaped cleanup")
			}
		})
	}
}
func TestSessionCloseFailureCannotConfirmGatewayRetirement(t *testing.T) {
	c := config(t)
	m := &fakeManager{open: func(r egress.OpenRequest) (egress.Opened, error) { return opened(r.CellID), nil }, closeErr: errors.New("private detail")}
	s, err := start(context.Background(), c, func(egress.ManagerDeps) manager { return m })
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := s.Close()
	if err == nil || receipt.GatewayClosed || !receipt.Echo.Closed || m.all != 1 {
		t.Fatal("false retirement receipt")
	}
}
