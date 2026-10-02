package egress

import (
	"compress/gzip"
	"context"
	"crypto/tls"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/netguard"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/scrub"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

const redacted = "keyd-redacted"

var errEncoding = errors.New("egress: upstream used a content encoding keyd cannot scrub")

// route is one request keyd forwards: where it goes and the audit line it will close.
type route struct {
	dest   keys.Dest
	target *url.URL
	line   audit.Line
	gen    *generation
}

func (c *Cell) servePlain(w http.ResponseWriter, r *http.Request) {
	line := audit.Line{Kind: audit.KindRequest, Mode: "http", Method: r.Method, Host: r.URL.Hostname(), Path: r.URL.Path}
	// A plain request never carries a surrogate. Looking before the host is checked catches one in
	// the host name too, which would otherwise be refused as an invalid name without an alert.
	if v := c.deps.Registry.Inspect(keys.Dest{Cell: c.cfg.CellID, Scheme: "http"}, r.Method, r.URL, r.Header); !v.Allow {
		line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	t, reason := policy.ParseHostPort(r.URL.Host, 80)
	if reason != "" {
		c.deny(w, line, http.StatusForbidden, reason)
		return
	}
	line.Host = t.Host
	if d := c.cfg.Policy.PlainHTTP(t); !d.Allow {
		c.deny(w, line, http.StatusForbidden, d.Reason)
		return
	}
	target := &url.URL{Scheme: "http", Host: t.Host, Path: r.URL.Path, RawPath: r.URL.RawPath, RawQuery: r.URL.RawQuery}
	c.forward(w, r, route{dest: keys.Dest{Cell: c.cfg.CellID, Scheme: "http", Host: t.Host}, target: target, line: line, gen: c.current()})
}

// forward checks a request bound for a host and swaps the surrogates it may carry, then relays it.
func (c *Cell) forward(w http.ResponseWriter, r *http.Request, rt route) {
	line := rt.line
	if r.Method == "TRACE" || r.Method == "TRACK" {
		c.deny(w, line, http.StatusMethodNotAllowed, ReasonMethod)
		return
	}
	if isUpgrade(r) && (rt.dest.Scheme != "http" || c.intercepted[rt.dest.Host]) {
		c.deny(w, line, http.StatusForbidden, ReasonUpgrade)
		return
	}
	v := c.deps.Registry.Inspect(rt.dest, r.Method, r.URL, r.Header)
	line.SecretID, line.SurrogateID = v.SecretID, v.SurrogateID
	if !v.Allow {
		c.deny(w, line, http.StatusForbidden, v.Reason)
		return
	}
	if status, reason := c.swap(r.Header, v.Swaps); reason != "" {
		c.deny(w, line, status, reason)
		return
	}
	line.Swapped = len(v.Swaps) > 0
	scrubber, err := c.scrubberFor(rt.dest)
	if err != nil {
		c.deny(w, line, http.StatusBadGateway, ReasonSecret)
		return
	}
	c.relay(w, r, rt, scrubber, line)
}

// swap puts the real values in. While the audit log cannot be written it refuses: the use of a
// secret is never left unrecorded.
func (c *Cell) swap(h http.Header, swaps []keys.Entry) (int, string) {
	if len(swaps) == 0 {
		return 0, ""
	}
	if c.deps.Audit.Err() != nil {
		return http.StatusServiceUnavailable, ReasonNoAudit
	}
	if err := keys.ApplySwaps(h, swaps, c.deps.Vault.Value); err != nil {
		return http.StatusBadGateway, ReasonSecret
	}
	return 0, ""
}

// relay sends the request with the generation's transport: verified upstream TLS, guarded dials,
// no other proxy, no redirects followed. The response is scrubbed on its way back, and the audit
// line is written once the body has been relayed or the attempt has failed.
func (c *Cell) relay(w http.ResponseWriter, r *http.Request, rt route, scrubber *scrub.Scrubber, line audit.Line) {
	start := time.Now()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer context.AfterFunc(rt.gen.ctx, cancel)()
	in := &counter{ReadCloser: r.Body}
	r.Body = in
	var once sync.Once
	finish := func(l audit.Line) {
		once.Do(func() {
			l.BytesIn, l.DurationMs = in.n, msSince(start)
			c.record(l)
		})
	}
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			target := *rt.target
			pr.Out.URL = &target
			pr.Out.Host = ""
			pr.Out.Header.Set("Accept-Encoding", "gzip")
		},
		Transport:     rt.gen.tr,
		FlushInterval: -1,
		ErrorLog:      log.New(io.Discard, "", 0),
		ModifyResponse: func(resp *http.Response) error {
			l := line
			l.Decision, l.Status = audit.Allow, resp.StatusCode
			if !bodyAllowed(r.Method, resp.StatusCode) {
				scrubber.Header(resp.Header)
				finish(l)
				return nil
			}
			gzipped, ok := coding(resp.Header.Values("Content-Encoding"))
			if !ok {
				return errEncoding
			}
			if gzipped {
				resp.Header.Del("Content-Encoding")
				resp.Body = &gunzip{body: resp.Body}
			}
			scrubber.Header(resp.Header)
			resp.Header.Del("Content-Length")
			resp.ContentLength = -1
			resp.Body = &tally{
				ReadCloser: scrubber.Reader(resp.Body),
				atEOF:      func() { scrubber.Header(resp.Trailer) },
				done: func(n int64, eof bool, err error) {
					l.BytesOut = n
					c.streamOutcome(&l, eof, err, r.Context(), rt.gen)
					finish(l)
				},
			}
			return nil
		},
		ErrorHandler: func(rw http.ResponseWriter, _ *http.Request, err error) {
			status, decision, reason := c.failure(err, r.Context(), rt.gen)
			l := line
			l.Decision, l.Reason, l.Status, l.Detail = decision, reason, status, err.Error()
			finish(l)
			if reason == ReasonClientGone {
				return
			}
			rw.Header().Set("X-Keyd-Reason", reason)
			http.Error(rw, "keyd: "+reason, status)
		},
	}
	proxy.ServeHTTP(scrubbedWriter{ResponseWriter: w, s: scrubber}, r.WithContext(ctx))
}

// scrubbedWriter scrubs the headers of informational responses, which ReverseProxy relays as they
// arrive, before ModifyResponse sees anything.
type scrubbedWriter struct {
	http.ResponseWriter
	s *scrub.Scrubber
}

func (w scrubbedWriter) WriteHeader(code int) {
	if code < 200 {
		w.s.Header(w.ResponseWriter.Header())
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w scrubbedWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// scrubberFor collects every secret bound to the destination; each is replaced by this cell's
// surrogate for it, or by a marker when the cell holds none.
func (c *Cell) scrubberFor(d keys.Dest) (*scrub.Scrubber, error) {
	mine := map[string]string{}
	for _, e := range c.deps.Registry.ForCell(c.cfg.CellID) {
		mine[e.Binding.SecretID] = e.Token
	}
	var pairs []scrub.Pair
	for _, rec := range c.deps.Vault.Records() {
		b, err := keys.FromRecord(rec)
		if err != nil {
			continue
		}
		hit := (rec.Kind == vault.KindHTTP && slices.Contains(b.Hosts, d.Host)) || (d.Scheme == "gateway" && b.Route == d.Route)
		if !hit {
			continue
		}
		value, err := c.deps.Vault.Value(rec.ID)
		if err != nil {
			return nil, err
		}
		repl := mine[rec.ID]
		if repl == "" {
			repl = redacted
		}
		pairs = append(pairs, scrub.Pair{Secret: value, Replacement: []byte(repl)})
	}
	return scrub.New(pairs...)
}

func (c *Cell) streamOutcome(l *audit.Line, eof bool, err error, reqCtx context.Context, g *generation) {
	switch {
	case eof && err == nil:
		return
	case g.ctx.Err() != nil:
		l.Decision, l.Reason = audit.Error, ReasonRevoked
	case reqCtx.Err() != nil:
		l.Decision, l.Reason = audit.Error, ReasonClientGone
	default:
		l.Decision, l.Reason = audit.Error, ReasonAborted
		if err != nil {
			l.Detail = err.Error()
		}
	}
}

// failure maps an error from before the response into a status, a decision and a reason.
func (c *Cell) failure(err error, reqCtx context.Context, g *generation) (int, string, string) {
	if errors.Is(err, errEncoding) {
		return http.StatusBadGateway, audit.Error, ReasonEncoding
	}
	if decision, reason := dialOutcome(err); reason != ReasonUpstream {
		status := http.StatusBadGateway
		if reason == ReasonAddress {
			status = http.StatusForbidden
		}
		return status, decision, reason
	}
	switch {
	case g.ctx.Err() != nil:
		return http.StatusServiceUnavailable, audit.Error, ReasonRevoked
	case reqCtx.Err() != nil:
		return 0, audit.Error, ReasonClientGone
	}
	return http.StatusBadGateway, audit.Error, ReasonUpstream
}

func dialOutcome(err error) (string, string) {
	var denied *netguard.DeniedError
	var resolve *netguard.ResolveError
	var cert *tls.CertificateVerificationError
	switch {
	case errors.As(err, &denied):
		return audit.Deny, ReasonAddress
	case errors.As(err, &resolve):
		return audit.Error, ReasonResolve
	case errors.As(err, &cert):
		return audit.Error, ReasonUpstreamTLS
	}
	return audit.Error, ReasonUpstream
}

// coding reads a response's Content-Encoding lines. Nothing, or a lone identity, leaves the body
// as it is; a lone gzip, which keyd asked for, is decoded so the scrubber reads the text. Any
// other coding, or more than one on any number of lines, is refused: a client would decode what
// keyd let by.
func coding(values []string) (gzipped, ok bool) {
	var codings []string
	for _, v := range values {
		for _, c := range strings.Split(v, ",") {
			if c = strings.TrimSpace(c); c != "" {
				codings = append(codings, strings.ToLower(c))
			}
		}
	}
	switch {
	case len(codings) == 0 || len(codings) == 1 && codings[0] == "identity":
		return false, true
	case len(codings) == 1 && codings[0] == "gzip":
		return true, true
	}
	return false, false
}

// gunzip decodes a gzip body as it is read, so a stream's first bytes do not wait.
type gunzip struct {
	body io.ReadCloser
	zr   *gzip.Reader
	err  error
}

func (g *gunzip) Read(p []byte) (int, error) {
	if g.zr == nil && g.err == nil {
		g.zr, g.err = gzip.NewReader(g.body)
	}
	if g.err != nil {
		return 0, g.err
	}
	return g.zr.Read(p)
}

func (g *gunzip) Close() error { return g.body.Close() }

func isUpgrade(r *http.Request) bool {
	return r.Header.Get("Upgrade") != "" || slices.ContainsFunc(r.Header.Values("Connection"), func(v string) bool {
		return strings.Contains(strings.ToLower(v), "upgrade")
	})
}

func bodyAllowed(method string, status int) bool {
	return method != http.MethodHead && status >= 200 && status != http.StatusNoContent && status != http.StatusNotModified
}

func msSince(t time.Time) float64 {
	return float64(time.Since(t).Microseconds()) / 1000
}

type counter struct {
	io.ReadCloser
	n int64
}

func (c *counter) Read(p []byte) (int, error) {
	n, err := c.ReadCloser.Read(p)
	c.n += int64(n)
	return n, err
}

// tally counts what reaches the client and reports once, on Close, how the stream ended.
type tally struct {
	io.ReadCloser
	n     int64
	eof   bool
	err   error
	atEOF func()
	done  func(n int64, eof bool, err error)
	once  sync.Once
}

func (t *tally) Read(p []byte) (int, error) {
	n, err := t.ReadCloser.Read(p)
	t.n += int64(n)
	switch {
	case err == io.EOF:
		if !t.eof {
			t.eof = true
			t.atEOF()
		}
	case err != nil:
		t.err = err
	}
	return n, err
}

func (t *tally) Close() error {
	err := t.ReadCloser.Close()
	t.once.Do(func() { t.done(t.n, t.eof, t.err) })
	return err
}
