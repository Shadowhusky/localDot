package canary

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func echo(t *testing.T) *Echo {
	t.Helper()
	e, err := NewEcho()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Close)
	return e
}
func client(e *Echo) *http.Client {
	return &http.Client{Timeout: time.Second, Transport: &http.Transport{
		DialContext: e.DialContext, TLSClientConfig: &tls.Config{RootCAs: e.RootCAs(), MinVersion: tls.VersionTLS12},
		DisableKeepAlives: true,
	}}
}
func TestAuthenticatedReflection(t *testing.T) {
	e := echo(t)
	req, _ := http.NewRequest("GET", "https://"+Host+e.Path(), nil)
	req.Header.Set("Authorization", "Bearer "+e.SyntheticSecret())
	response, err := client(e).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || response.Header.Get("X-Canary-Key") != e.SyntheticSecret() {
		t.Fatal("missing reflection")
	}
	var result map[string]string
	if json.Unmarshal(body, &result) != nil {
		t.Fatal("invalid response")
	}
	if result["challenge"] != e.Challenge() || result["authorization"] != "Bearer "+e.SyntheticSecret() ||
		result["base64"] != base64.StdEncoding.EncodeToString([]byte(e.SyntheticSecret())) || result["hex"] != hex.EncodeToString([]byte(e.SyntheticSecret())) {
		t.Fatal("incomplete reflection")
	}
	e.Close()
	receipt := e.Receipt()
	if receipt != (Receipt{Started: 1, Authenticated: 1, Reflected: 1, Closed: true}) {
		t.Fatalf("bad receipt: %+v", receipt)
	}
	encoded, _ := json.Marshal(receipt)
	if strings.Contains(string(encoded), e.SyntheticSecret()) {
		t.Fatal("receipt leaked synthetic needle")
	}
}
func TestRefusesOtherAuthoritiesWithoutConnections(t *testing.T) {
	e := echo(t)
	for _, target := range []string{"127.0.0.1:443", "example.com:443", Host + ":80", Host + ":0443", "user@" + Host + ":443", strings.ToUpper(Host) + ":443"} {
		if conn, err := e.DialContext(context.Background(), "tcp", target); err == nil || conn != nil {
			t.Fatal("foreign authority admitted")
		}
	}
	if _, err := e.DialContext(context.Background(), "udp", Host+":443"); err == nil {
		t.Fatal("UDP admitted")
	}
	if e.Receipt().Started != 0 {
		t.Fatal("refusal created a worker")
	}
}
func TestWrongCredentialsOrRequestCannotProducePositiveReceipt(t *testing.T) {
	for _, fault := range []string{"missing", "surrogate", "duplicate", "path", "host", "method", "body"} {
		t.Run(fault, func(t *testing.T) {
			e := echo(t)
			req, _ := http.NewRequest("GET", "https://"+Host+e.Path(), nil)
			req.Header.Set("Authorization", "Bearer "+e.SyntheticSecret())
			switch fault {
			case "missing":
				req.Header.Del("Authorization")
			case "surrogate":
				req.Header.Set("Authorization", "Bearer ld_key_synthetic")
			case "duplicate":
				req.Header.Add("Authorization", "Bearer "+e.SyntheticSecret())
			case "path":
				req.URL.Path += "/wrong"
			case "host":
				req.Host = "other.invalid"
			case "method":
				req.Method = "POST"
			case "body":
				req.Body = io.NopCloser(strings.NewReader("x"))
				req.ContentLength = 1
			}
			response, err := client(e).Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			e.Close()
			if response.StatusCode == 200 || strings.Contains(string(body), e.SyntheticSecret()) || e.Receipt().Authenticated != 0 || e.Receipt().Reflected != 0 {
				t.Fatal("invalid request certified")
			}
		})
	}
}
func TestCertificateAndSNIRequired(t *testing.T) {
	e := echo(t)
	for _, name := range []string{"other.invalid", ""} {
		raw, err := e.DialContext(context.Background(), "tcp", Host+":443")
		if err != nil {
			t.Fatal(err)
		}
		conn := tls.Client(raw, &tls.Config{RootCAs: e.RootCAs(), ServerName: name, MinVersion: tls.VersionTLS12})
		if conn.Handshake() == nil {
			t.Fatal("wrong SNI trusted")
		}
		raw.Close()
		// This client accepts any certificate, so only the echo's own pin can refuse the name.
		raw, err = e.DialContext(context.Background(), "tcp", Host+":443")
		if err != nil {
			t.Fatal(err)
		}
		conn = tls.Client(raw, &tls.Config{InsecureSkipVerify: true, ServerName: name, MinVersion: tls.VersionTLS12})
		if conn.Handshake() == nil {
			t.Fatalf("the echo accepted the server name %q", name)
		}
		raw.Close()
	}
	c := client(e)
	c.Transport.(*http.Transport).TLSClientConfig.RootCAs = nil
	if response, err := c.Get("https://" + Host + e.Path()); err == nil {
		response.Body.Close()
		t.Fatal("untrusted certificate accepted")
	}
}
func TestCloseDrainsStalledPipesAndRefusesNewWork(t *testing.T) {
	e := echo(t)
	raw, err := e.DialContext(context.Background(), "tcp", Host+".:443")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { e.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("close did not drain")
	}
	if _, err := raw.Write([]byte("late")); err == nil {
		t.Fatal("pipe remains open")
	}
	if _, err := e.DialContext(context.Background(), "tcp", Host+":443"); err == nil {
		t.Fatal("closed dial admitted")
	}
	if e.Receipt().Active != 0 {
		t.Fatal("worker remains")
	}
}
func TestCancellationAndConcurrencyBound(t *testing.T) {
	e := echo(t)
	ctx, cancel := context.WithCancel(context.Background())
	for i := 0; i < 4; i++ {
		if _, err := e.DialContext(ctx, "tcp", Host+":443"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.DialContext(ctx, "tcp", Host+":443"); err == nil {
		t.Fatal("unbounded workers")
	}
	cancel()
	e.Close()
	if _, err := echo(t).DialContext(ctx, "tcp", Host+":443"); err == nil {
		t.Fatal("cancelled dial admitted")
	}
	if e.Receipt().Active != 0 {
		t.Fatal("cancelled workers retained")
	}
}

func TestTotalConnectionBound(t *testing.T) {
	e := echo(t)
	for i := 0; i < 16; i++ {
		conn, err := e.DialContext(context.Background(), "tcp", Host+":443")
		if err != nil {
			t.Fatal(err)
		}
		conn.Close()
		e.workers.Wait()
	}
	if _, err := e.DialContext(context.Background(), "tcp", Host+":443"); err == nil {
		t.Fatal("connection budget exceeded")
	}
	if e.Receipt().Started != 16 {
		t.Fatal("incorrect connection accounting")
	}
}

func TestOversizedHeadersNeverAuthenticate(t *testing.T) {
	e := echo(t)
	raw, err := e.DialContext(context.Background(), "tcp", Host+":443")
	if err != nil {
		t.Fatal(err)
	}
	conn := tls.Client(raw, &tls.Config{RootCAs: e.RootCAs(), ServerName: Host, MinVersion: tls.VersionTLS12})
	if err := conn.Handshake(); err != nil {
		t.Fatal(err)
	}
	_, _ = io.WriteString(conn, "GET "+e.Path()+" HTTP/1.1\r\nHost: "+Host+"\r\nAuthorization: Bearer "+e.SyntheticSecret()+"\r\nX-Padding: "+strings.Repeat("x", 17000)+"\r\n\r\n")
	conn.Close()
	e.Close()
	if e.Receipt().Authenticated != 0 || e.Receipt().Reflected != 0 {
		t.Fatal("oversized request admitted")
	}
}
