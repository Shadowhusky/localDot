package egress

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"unicode"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
)

// isInternal reports whether u names keyd.ldot on port 80: ASCII letters in any case only, since
// strings.EqualFold alone would also take U+212A (Kelvin) for the k, and no other port.
func isInternal(u *url.URL) bool {
	return isVirtualHost(u, internalHost)
}

func isVirtualHost(u *url.URL, host string) bool {
	name := strings.TrimSuffix(u.Host, ":80")
	return !strings.ContainsFunc(name, func(r rune) bool { return r > unicode.MaxASCII }) && strings.EqualFold(name, host)
}

// serveInternal answers keyd.ldot, the name a cell's boot self-test uses to prove its proxy path
// and token without reaching the internet.
func (c *Cell) serveInternal(w http.ResponseWriter, r *http.Request) {
	line := audit.Line{Kind: audit.KindRequest, Mode: "internal", Method: r.Method, Host: internalHost, Path: r.URL.Path}
	if r.URL.Path != "/health" {
		c.deny(w, line, http.StatusNotFound, ReasonNotFound)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
		return
	}
	line.Decision, line.Status = audit.Allow, http.StatusOK
	c.record(line)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "cell": c.cfg.CellID})
}
