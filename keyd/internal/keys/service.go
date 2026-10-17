package keys

import "github.com/shadowhusky/localdot/keyd/internal/vault"

// ServiceBinding permits a user's saved key at its existing HTTPS destination. Only the daemon's
// service role uses this view; brain gateway routes and their token budgets stay unchanged.
// Provider APIs may charge for non-chat operations: their quotas are enforced by the provider.
func ServiceBinding(rec vault.Record) (Binding, error) {
	b, err := FromRecord(rec)
	if err != nil {
		return Binding{}, err
	}
	if rec.Kind == vault.KindLLM {
		b.Hosts = []string{b.Upstream.Hostname()}
		if b.Upstream.Path != "" && b.Upstream.Path != "/" {
			b.Paths = []string{b.Upstream.Path}
		}
		b.Route = ""
		b.Upstream = nil
		b.Ops = nil
	}
	return b, nil
}
