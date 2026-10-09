package webpush

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
)

const (
	MaxMessage = 4096
	maxTTL     = 28 * 24 * 60 * 60
	timeout    = 10 * time.Second
)

// The browsers' push services. A subscription that names any other host is refused, so this path
// can reach nothing but them, whatever the daemon asks.
var serviceSuffixes = []string{
	"push.apple.com",
	"fcm.googleapis.com",
	"push.services.mozilla.com",
	"notify.windows.com",
}

var (
	ErrNotPushService = errors.New("webpush: not a push service endpoint")
	ErrBadMessage     = errors.New("webpush: bad message")
	ErrUnreachable    = errors.New("webpush: the push service could not be reached")
	topicPattern      = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	urgencies         = map[string]bool{"very-low": true, "low": true, "normal": true, "high": true}
)

// Request is one encrypted message for one subscription. Body is the RFC 8291 aes128gcm message,
// base64url; keyd never sees what it says.
type Request struct {
	Endpoint string `json:"endpoint"`
	TTL      int    `json:"ttl"`
	Urgency  string `json:"urgency"`
	Topic    string `json:"topic,omitempty"`
	Body     string `json:"body"`
}

// Result is the push service's answer. Gone means the subscription has ended for good.
type Result struct {
	Status int  `json:"status"`
	Gone   bool `json:"gone"`
}

type Sender struct {
	signer *Signer
	client *http.Client
	audit  *audit.Log
}

func NewSender(signer *Signer, client *http.Client, auditLog *audit.Log) *Sender {
	return &Sender{signer: signer, client: client, audit: auditLog}
}

// Client dials only through dial (keyd's guarded dialer), follows no redirect and gives up after
// ten seconds.
func Client(dial func(ctx context.Context, network, address string) (net.Conn, error)) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext:         dial,
			Proxy:               nil,
			ForceAttemptHTTP2:   true,
			MaxIdleConns:        8,
			IdleConnTimeout:     90 * time.Second,
			TLSHandshakeTimeout: timeout,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func (s *Sender) PublicKey() (string, error) { return s.signer.PublicKey() }

// ServiceEndpoint accepts only an https URL on port 443 of a known push service.
func ServiceEndpoint(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return nil, ErrNotPushService
	}
	if port := u.Port(); port != "" && port != "443" {
		return nil, ErrNotPushService
	}
	host := strings.ToLower(u.Hostname())
	for _, suffix := range serviceSuffixes {
		if host == suffix || strings.HasSuffix(host, "."+suffix) {
			return u, nil
		}
	}
	return nil, ErrNotPushService
}

func (s *Sender) Send(ctx context.Context, req Request) (Result, error) {
	u, err := ServiceEndpoint(req.Endpoint)
	if err != nil {
		host := ""
		if parsed, perr := url.Parse(req.Endpoint); perr == nil {
			host = parsed.Hostname()
		}
		s.write(audit.Line{Kind: audit.KindPush, Method: http.MethodPost, Host: host, Decision: audit.Deny, Reason: "not a push service"})
		return Result{}, err
	}
	body, err := base64.RawURLEncoding.DecodeString(req.Body)
	if err != nil || len(body) == 0 || len(body) > MaxMessage || req.TTL < 0 || req.TTL > maxTTL ||
		!urgencies[req.Urgency] || (req.Topic != "" && !topicPattern.MatchString(req.Topic)) {
		return Result{}, ErrBadMessage
	}
	// The audience is the canonical origin: ServiceEndpoint allows only the default port.
	token, err := s.signer.SignVAPID("https://" + strings.ToLower(u.Hostname()))
	if err != nil {
		return Result{}, err
	}
	key, err := s.signer.PublicKey()
	if err != nil {
		return Result{}, err
	}
	out, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return Result{}, ErrBadMessage
	}
	out.Header.Set("Authorization", "vapid t="+token+", k="+key)
	out.Header.Set("Content-Encoding", "aes128gcm")
	out.Header.Set("Content-Type", "application/octet-stream")
	out.Header.Set("TTL", strconv.Itoa(req.TTL))
	out.Header.Set("Urgency", req.Urgency)
	if req.Topic != "" {
		out.Header.Set("Topic", req.Topic)
	}
	line := audit.Line{Kind: audit.KindPush, Method: http.MethodPost, Host: u.Hostname(), BytesOut: int64(len(body))}
	started := time.Now()
	res, err := s.client.Do(out)
	line.DurationMs = float64(time.Since(started).Microseconds()) / 1000
	if err != nil {
		line.Decision, line.Reason = audit.Error, "unreachable"
		s.write(line)
		return Result{}, ErrUnreachable
	}
	defer res.Body.Close()
	io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
	line.Decision, line.Status = audit.Allow, res.StatusCode
	s.write(line)
	return Result{Status: res.StatusCode, Gone: res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone}, nil
}

func (s *Sender) write(line audit.Line) {
	if s.audit == nil {
		return
	}
	if _, err := s.audit.Write(line); err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
}
