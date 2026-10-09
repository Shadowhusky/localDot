// Package egress is a cell's door to the outside: one explicit HTTP proxy per cell on 127.0.0.1,
// guarded by the cell's proxy token. It refuses what policy refuses, terminates TLS only for the
// hosts the cell's surrogates are bound to, swaps surrogates there and scrubs what comes back,
// and passes every other allowed host through after checking its SNI.
package egress

import (
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"maps"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/elazarl/goproxy"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/events"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
)

const (
	ReasonAuthMissing   = "proxy-auth-missing"
	ReasonAuthInvalid   = "proxy-auth-invalid"
	ReasonBadRequest    = "bad-request"
	ReasonMethod        = "method-not-allowed"
	ReasonNotFound      = "not-found"
	ReasonHandshake     = "tls-handshake-failed"
	ReasonHostMismatch  = "host-mismatch"
	ReasonUpgrade       = "upgrade-refused"
	ReasonAddress       = "address-denied"
	ReasonResolve       = "resolve-failed"
	ReasonUpstream      = "upstream-error"
	ReasonUpstreamTLS   = "upstream-tls"
	ReasonAborted       = "upstream-aborted"
	ReasonClientGone    = "client-aborted"
	ReasonRevoked       = "revoked"
	ReasonEncoding      = "undecodable-encoding"
	ReasonSecret        = "secret-unavailable"
	ReasonNoAudit       = "audit-unavailable"
	ReasonConnectionCap = "connection-cap"
)

const (
	internalHost = "keyd.ldot"
	minTokenLen  = 32
	// maxHeaderBytes caps a request's line and headers. API calls need a few KiB; the cap bounds
	// what one request makes keyd search for surrogates (net/http's default is 1 MiB).
	maxHeaderBytes = 64 << 10
	// Enough parallel fetches for a desktop browser, while bounding unauthenticated sockets
	// and hijacked tunnels to 64 accepted client sockets per cell.
	maxCellConnections = 64
)

var ErrPortInUse = errors.New("egress: listener port in use")

type Cell struct {
	cfg            Config
	deps           Deps
	ln             net.Listener
	srv            *http.Server
	connect        *goproxy.ProxyHttpServer
	intercepted    map[string]bool
	authLog        rateLog
	connectionLog  rateLog
	asks           askBook
	mu             sync.Mutex
	gen            *generation
	closed         bool
	policyChanging bool
}

func Open(cfg Config, deps Deps) (*Cell, error) {
	if len(cfg.Token) < minTokenLen {
		return nil, fmt.Errorf("egress: proxy token must be at least %d characters", minTokenLen)
	}
	ln, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.Port)))
	if errors.Is(err, syscall.EADDRINUSE) {
		return nil, fmt.Errorf("%w: %d", ErrPortInUse, cfg.Port)
	}
	if err != nil {
		return nil, err
	}
	c := &Cell{cfg: cfg, deps: deps, ln: ln, gen: newGeneration(deps), intercepted: map[string]bool{}}
	if cfg.CA != nil {
		for _, host := range cfg.CA.Hosts() {
			c.intercepted[host] = true
		}
	}
	c.ln = &limitedListener{Listener: ln, slots: make(chan struct{}, maxCellConnections), refused: c.refuseConnection}
	c.connect = c.newConnectProxy()
	c.srv = &http.Server{
		Handler:           c,
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    maxHeaderBytes,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          log.New(io.Discard, "", 0),
		// Otherwise http.Server answers OPTIONS * itself, before the token check and the audit.
		DisableGeneralOptionsHandler: true,
	}
	go c.srv.Serve(c.ln)
	return c, nil
}

func (c *Cell) ID() string { return c.cfg.CellID }

func (c *Cell) Port() int { return c.ln.Addr().(*net.TCPAddr).Port }

// Close stops the listener and closes every connection the cell has, upstream ones included.
func (c *Cell) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	g := c.gen
	c.mu.Unlock()
	err := c.srv.Close()
	g.stop()
	return err
}

// Revoke is the kill switch for one cell: every upstream connection and tunnel closes, in-flight
// requests fail, and the cell starts a fresh generation.
func (c *Cell) Revoke() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	old := c.gen
	if !c.policyChanging {
		c.gen = newGeneration(c.deps)
	}
	c.mu.Unlock()
	old.stop()
}

func (c *Cell) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	via, reason := c.authorize(r.Header.Values("Proxy-Authorization"))
	if reason != "" {
		c.refuseAuth(w, r, reason)
		return
	}
	r.Header.Del("Proxy-Authorization")
	line := audit.Line{Kind: audit.KindRequest, Method: r.Method, Host: r.URL.Hostname(), Path: r.URL.Path}
	switch {
	case via == ViaCapture && r.Method != http.MethodConnect:
		c.deny(w, line, http.StatusBadRequest, ReasonCaptureUse)
	case r.Method == http.MethodConnect:
		c.connect.ServeHTTP(w, withVia(r, via))
	case !r.URL.IsAbs() || r.URL.Scheme != "http":
		c.deny(w, line, http.StatusBadRequest, ReasonBadRequest)
	case isInternal(r.URL):
		c.serveInternal(w, r)
	case isGateway(r.URL) && c.cfg.Policy.Gateway:
		c.serveGateway(w, r)
	default:
		c.servePlain(w, r)
	}
}

// authorize accepts only Basic credentials whose password is the cell's token, or the gate's
// capture token, and says which of the two came.
func (c *Cell) authorize(values []string) (string, string) {
	if len(values) == 0 {
		return "", ReasonAuthMissing
	}
	scheme, encoded, ok := strings.Cut(values[0], " ")
	if len(values) > 1 || !ok || !strings.EqualFold(scheme, "Basic") {
		return "", ReasonAuthInvalid
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return "", ReasonAuthInvalid
	}
	_, pass, ok := strings.Cut(string(raw), ":")
	switch {
	case !ok:
		return "", ReasonAuthInvalid
	case subtle.ConstantTimeCompare([]byte(pass), []byte(c.cfg.Token)) == 1:
		return ViaProxy, ""
	case c.cfg.CaptureToken != "" && subtle.ConstantTimeCompare([]byte(pass), []byte(c.cfg.CaptureToken)) == 1:
		return ViaCapture, ""
	}
	return "", ReasonAuthInvalid
}

// refuseAuth answers 407. Any container with egress can reach the listener, so refusals are
// audited at most once a second, with the number left out.
func (c *Cell) refuseAuth(w http.ResponseWriter, r *http.Request, reason string) {
	r.Close = true
	w.Header().Set("Connection", "close")
	// net/http otherwise drains a small unread request body before closing. A client that
	// withholds that body must not keep an unauthenticated socket indefinitely.
	_ = http.NewResponseController(w).SetReadDeadline(time.Now())
	if ok, suppressed := c.authLog.allow(time.Now()); ok {
		l := audit.Line{Kind: audit.KindRequest, Method: r.Method, Host: r.URL.Hostname(), Decision: audit.Deny, Reason: reason, Status: http.StatusProxyAuthRequired}
		if r.Method == http.MethodConnect {
			l.Kind, l.Host = audit.KindConnect, r.Host
		}
		if suppressed > 0 {
			l.Detail = fmt.Sprintf("%d earlier refusals not logged", suppressed)
		}
		c.record(l)
	}
	w.Header().Set("Proxy-Authenticate", `Basic realm="localdot-keyd"`)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: proxy authentication required", http.StatusProxyAuthRequired)
}

func (c *Cell) refuseConnection() {
	if ok, suppressed := c.connectionLog.allow(time.Now()); ok {
		line := audit.Line{Kind: audit.KindRequest, Decision: audit.Deny, Reason: ReasonConnectionCap}
		if suppressed > 0 {
			line.Detail = fmt.Sprintf("%d earlier refusals not logged", suppressed)
		}
		c.record(line)
	}
}

func (c *Cell) interceptedHosts() map[string]bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return maps.Clone(c.intercepted)
}

func (c *Cell) deny(w http.ResponseWriter, l audit.Line, status int, reason string) {
	l.Decision, l.Reason, l.Status = audit.Deny, reason, status
	c.record(l)
	w.Header().Set("X-Keyd-Reason", reason)
	http.Error(w, "keyd: "+reason, status)
}

var alerts = map[string]bool{
	keys.ReasonUnknownSurrogate:   true,
	keys.ReasonMisplacedSurrogate: true,
	keys.ReasonSurrogatePolicy:    true,
	ReasonSurrogateMissing:        true,
}

// record writes the audit line and, for every use or misuse of a surrogate, a key.use event made
// from the line as written, so the event carries no surrogate either.
func (c *Cell) record(l audit.Line) {
	l.Cell, l.Port = c.cfg.CellID, c.Port()
	l, err := c.deps.Audit.Write(l)
	if err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
	if l.SecretID == "" && !alerts[l.Reason] {
		return
	}
	secret, decision := l.SecretID, "deny"
	if secret == "" {
		secret = "unknown"
	}
	if l.Swapped {
		decision = "allow"
	}
	c.deps.Events.Publish(events.Event{Type: events.TypeKeyUse, Cell: c.cfg.CellID, Data: events.KeyUse{
		SecretID: secret, Host: l.Host, Method: l.Method, Path: l.Path, Decision: decision,
	}})
}

func (c *Cell) current() *generation {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.gen
}

type rateLog struct {
	mu         sync.Mutex
	last       time.Time
	suppressed int
}

func (r *rateLog) allow(now time.Time) (bool, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if now.Sub(r.last) < time.Second {
		r.suppressed++
		return false, 0
	}
	n := r.suppressed
	r.last, r.suppressed = now, 0
	return true, n
}
