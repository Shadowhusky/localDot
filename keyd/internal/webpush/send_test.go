package webpush

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

type pushed struct {
	host, path, auth, ttl, urgency, topic, encoding string
	body                                            []byte
}

// pushFixture is a TLS push service; every dial lands on it, whatever host the URL names.
func pushFixture(t *testing.T, status int) (*Sender, *[]pushed, string) {
	t.Helper()
	var got []pushed
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("Location", "https://elsewhere.example/")
		got = append(got, pushed{r.Host, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("TTL"),
			r.Header.Get("Urgency"), r.Header.Get("Topic"), r.Header.Get("Content-Encoding"), body})
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	client := Client(func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	})
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com"}
	logPath := filepath.Join(t.TempDir(), "audit.jsonl")
	log, err := audit.Open(logPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { log.Close() })
	return NewSender(NewSigner(vault.NewMemory(), never, fixedNow), client, log), &got, logPath
}

func message() string { return base64.RawURLEncoding.EncodeToString([]byte("ciphertext-bytes")) }

func TestSendsSignedMessageToApple(t *testing.T) {
	s, got, logPath := pushFixture(t, http.StatusCreated)
	res, err := s.Send(context.Background(), Request{
		Endpoint: "https://web.push.apple.com/QGuR-capability-token", TTL: 600, Urgency: "high",
		Topic: "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ", Body: message(),
	})
	if err != nil || res != (Result{Status: 201}) {
		t.Fatalf("res %+v err %v", res, err)
	}
	p := (*got)[0]
	if p.host != "web.push.apple.com" || p.path != "/QGuR-capability-token" || p.ttl != "600" ||
		p.urgency != "high" || p.topic != "01J9ZQ4V5W6X7Y8Z9ABCDEFGHJ" || p.encoding != "aes128gcm" ||
		string(p.body) != "ciphertext-bytes" {
		t.Fatalf("pushed %+v", p)
	}
	key, _ := s.PublicKey()
	parts := strings.SplitN(strings.TrimPrefix(p.auth, "vapid t="), ", k=", 2)
	if len(parts) != 2 || parts[1] != key {
		t.Fatalf("authorization %q", p.auth)
	}
	if claims := verifyJWT(t, parts[0], key); claims["aud"] != "https://web.push.apple.com" {
		t.Fatalf("aud %v", claims["aud"])
	}
	raw, _ := os.ReadFile(logPath)
	if !strings.Contains(string(raw), `"kind":"push"`) || !strings.Contains(string(raw), `"host":"web.push.apple.com"`) ||
		strings.Contains(string(raw), "QGuR-capability-token") {
		t.Fatalf("audit must name the host and status, never the subscription path: %s", raw)
	}
}

func TestGoneSubscriptionIsReported(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusGone} {
		s, _, _ := pushFixture(t, status)
		res, err := s.Send(context.Background(), Request{Endpoint: "https://fcm.googleapis.com/fcm/send/abc", TTL: 60, Urgency: "normal", Body: message()})
		if err != nil || !res.Gone || res.Status != status {
			t.Fatalf("status %d: res %+v err %v", status, res, err)
		}
	}
}

func TestRefusesEverythingButPushServices(t *testing.T) {
	s, got, logPath := pushFixture(t, http.StatusCreated)
	for _, endpoint := range []string{
		"http://web.push.apple.com/QGuR-refused-capability",
		"https://web.push.apple.com:8443/QGuR-refused-capability",
		"https://evil.example/QGuR-refused-capability",
		"https://push.apple.com.evil.example/QGuR-refused-capability",
		"https://evilpush.apple.com/QGuR-refused-capability",
		"https://user@web.push.apple.com/QGuR-refused-capability",
		"https://127.0.0.1/QGuR-refused-capability",
		"https://localhost/QGuR-refused-capability",
		"https://web.push.apple.com/QGuR-refused-capability#frag",
		"not a url",
	} {
		if _, err := s.Send(context.Background(), Request{Endpoint: endpoint, TTL: 60, Urgency: "normal", Body: message()}); !errors.Is(err, ErrNotPushService) {
			t.Fatalf("%s: want ErrNotPushService, got %v", endpoint, err)
		}
	}
	if len(*got) != 0 {
		t.Fatal("a refused endpoint must never be dialled")
	}
	raw, _ := os.ReadFile(logPath)
	if !strings.Contains(string(raw), `"decision":"deny"`) {
		t.Fatal("a refusal is audited")
	}
	if strings.Contains(string(raw), "QGuR-refused-capability") {
		t.Fatalf("a refusal must never log the subscription path: %s", raw)
	}
}

func TestAudienceIsTheCanonicalOrigin(t *testing.T) {
	for _, endpoint := range []string{
		"https://WEB.PUSH.APPLE.COM/x",
		"https://web.push.apple.com:443/x",
		"https://web.push.apple.com:/x",
	} {
		s, got, _ := pushFixture(t, http.StatusCreated)
		if _, err := s.Send(context.Background(), Request{Endpoint: endpoint, TTL: 60, Urgency: "normal", Body: message()}); err != nil {
			t.Fatalf("%s: %v", endpoint, err)
		}
		key, _ := s.PublicKey()
		token := strings.SplitN(strings.TrimPrefix((*got)[0].auth, "vapid t="), ", k=", 2)[0]
		if aud := verifyJWT(t, token, key)["aud"]; aud != "https://web.push.apple.com" {
			t.Fatalf("%s: aud %v", endpoint, aud)
		}
	}
}

func TestRefusesBadMessages(t *testing.T) {
	s, got, _ := pushFixture(t, http.StatusCreated)
	big := base64.RawURLEncoding.EncodeToString(make([]byte, MaxMessage+1))
	for name, req := range map[string]Request{
		"too big":    {TTL: 60, Urgency: "normal", Body: big},
		"empty":      {TTL: 60, Urgency: "normal", Body: ""},
		"not base64": {TTL: 60, Urgency: "normal", Body: "***"},
		"ttl":        {TTL: maxTTL + 1, Urgency: "normal", Body: message()},
		"negative":   {TTL: -1, Urgency: "normal", Body: message()},
		"urgency":    {TTL: 60, Urgency: "urgent", Body: message()},
		"topic":      {TTL: 60, Urgency: "normal", Topic: "has spaces", Body: message()},
		"long topic": {TTL: 60, Urgency: "normal", Topic: strings.Repeat("a", 33), Body: message()},
	} {
		req.Endpoint = "https://web.push.apple.com/x"
		if _, err := s.Send(context.Background(), req); !errors.Is(err, ErrBadMessage) {
			t.Fatalf("%s: want ErrBadMessage, got %v", name, err)
		}
	}
	if len(*got) != 0 {
		t.Fatal("a bad message must never be sent")
	}
}

func TestDoesNotFollowRedirects(t *testing.T) {
	s, got, _ := pushFixture(t, http.StatusFound)
	res, err := s.Send(context.Background(), Request{Endpoint: "https://updates.push.services.mozilla.com/wpush/v2/x", TTL: 60, Urgency: "low", Body: message()})
	if err != nil || res.Status != http.StatusFound || len(*got) != 1 {
		t.Fatalf("res %+v err %v sent %d", res, err, len(*got))
	}
}
