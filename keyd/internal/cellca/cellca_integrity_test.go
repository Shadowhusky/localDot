package cellca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// S4 (D7) showed Chromium 154 trusting, and enforcing the constraints of, a P-256 CA with critical
// CA:TRUE pathlen:0, critical keyCertSign and cRLSign, and critical permitted DNS names.
func TestTheCAKeepsTheProfileS4ProvedInChromium(t *testing.T) {
	before := time.Now()
	ca, err := New("cell-1", []string{"api.example.test"})
	if err != nil {
		t.Fatal(err)
	}
	after := time.Now()
	c := ca.Certificate()
	if pub, ok := c.PublicKey.(*ecdsa.PublicKey); !ok || pub.Curve != elliptic.P256() {
		t.Fatalf("CA key %T, want ECDSA P-256", c.PublicKey)
	}
	if c.KeyUsage != x509.KeyUsageCertSign|x509.KeyUsageCRLSign {
		t.Fatalf("CA key usage %v, want certificate and CRL signing only", c.KeyUsage)
	}
	if got := c.NotAfter.Sub(c.NotBefore); got != 397*24*time.Hour+time.Hour {
		t.Fatalf("CA lifetime %v, want 397 days from an hour back", got)
	}
	if c.NotBefore.Before(before.Add(-time.Hour-time.Second)) || c.NotBefore.After(after.Add(-time.Hour)) {
		t.Fatalf("CA valid from %v, made at %v", c.NotBefore, before)
	}
}

func TestTheConstraintsPermitTheHostsAndNoAddress(t *testing.T) {
	ca, _ := New("cell-1", []string{"postman-echo.com", "api.example.test"})
	c := ca.Certificate()
	if got := slices.Sorted(slices.Values(c.PermittedDNSDomains)); !slices.Equal(got, []string{"api.example.test", "postman-echo.com"}) {
		t.Fatalf("permitted %v", c.PermittedDNSDomains)
	}
	if got := slices.Sorted(slices.Values(c.ExcludedDNSDomains)); !slices.Equal(got, []string{".api.example.test", ".postman-echo.com"}) {
		t.Fatalf("excluded names %v, want every host's subdomains", c.ExcludedDNSDomains)
	}
	var excluded []string
	for _, r := range c.ExcludedIPRanges {
		excluded = append(excluded, r.String())
	}
	if !slices.Equal(excluded, []string{"0.0.0.0/0", "::/0"}) {
		t.Fatalf("excluded IP ranges %v, want all of IPv4 and IPv6", excluded)
	}
}

// api.example.test ends in pi.example.test without being beneath it.
func TestAForgedLeafForASubdomainOfABoundHostIsRefused(t *testing.T) {
	ca, err := New("cell-1", []string{"api.example.test", "pi.example.test"})
	if err != nil {
		t.Fatal(err)
	}
	for name, host := range map[string]string{
		"x.api.example.test":  "x.api.example.test",
		"*.api.example.test":  "y.api.example.test",
		"x.pi.example.test":   "x.pi.example.test",
		"a.b.pi.example.test": "a.b.pi.example.test",
	} {
		if err := verify(ca, forge(t, ca, []string{name}, nil), host); !notAuthorized(err) {
			t.Errorf("a forged leaf for %s: %v", name, err)
		}
	}
	for _, host := range ca.Hosts() {
		cert, err := ca.Leaf(host)
		if err != nil {
			t.Fatal(err)
		}
		if err := verify(ca, cert.Leaf, host); err != nil {
			t.Errorf("the bound %s: %v", host, err)
		}
	}
}

// One CA cannot also refuse the parent's other subdomains, such as x.example.test: the subtree that
// permits example.test holds them all, and only excluding .example.test would cover every one,
// which would refuse api.example.test too.
func TestNestedBoundHostsBothVerifyAndTheInnerSubtreeIsRefused(t *testing.T) {
	ca, err := New("cell-1", []string{"example.test", "api.example.test"})
	if err != nil {
		t.Fatal(err)
	}
	for _, host := range []string{"example.test", "api.example.test"} {
		cert, err := ca.Leaf(host)
		if err != nil {
			t.Fatal(err)
		}
		if err := verify(ca, cert.Leaf, host); err != nil {
			t.Errorf("the bound %s: %v", host, err)
		}
	}
	if err := verify(ca, forge(t, ca, []string{"x.api.example.test"}, nil), "x.api.example.test"); !notAuthorized(err) {
		t.Errorf("a forged leaf beneath the inner bound host: %v", err)
	}
	if got := ca.Certificate().ExcludedDNSDomains; !slices.Equal(got, []string{".api.example.test"}) {
		t.Errorf("excluded names %v, want only the inner host's subdomains", got)
	}
}

func TestNewRefusesAnEmptyHost(t *testing.T) {
	for _, hosts := range [][]string{{""}, {"api.example.test", ""}} {
		if ca, err := New("cell-1", hosts); !errors.Is(err, errEmptyHost) || ca != nil {
			t.Errorf("New(%q): CA made %v, error %v; an empty name constraint permits every name", hosts, ca != nil, err)
		}
	}
}

func TestAForgedCertificateCannotWidenTheConstraints(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	for name, leaf := range map[string]*x509.Certificate{
		"an unbound name beside the bound one":  forge(t, ca, []string{"api.example.test", "bank.example"}, nil),
		"an IPv4 address beside the bound name": forge(t, ca, []string{"api.example.test"}, []net.IP{net.ParseIP("203.0.113.7")}),
		"an IPv6 address beside the bound name": forge(t, ca, []string{"api.example.test"}, []net.IP{net.ParseIP("2001:db8::1")}),
	} {
		if err := verify(ca, leaf, "api.example.test"); !notAuthorized(err) {
			t.Errorf("a forged leaf with %s: %v", name, err)
		}
	}

	interKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, err := x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber:          big.NewInt(98),
		Subject:               pkix.Name{CommonName: "forged CA"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}, ca.cert, &interKey.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	inter, _ := x509.ParseCertificate(der)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	der, err = x509.CreateCertificate(rand.Reader, &x509.Certificate{
		SerialNumber: big.NewInt(97),
		DNSNames:     []string{"api.example.test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}, inter, &leafKey.PublicKey, interKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := x509.ParseCertificate(der)
	intermediates := x509.NewCertPool()
	intermediates.AddCert(inter)
	_, err = leaf.Verify(x509.VerifyOptions{DNSName: "api.example.test", Roots: pool(ca), Intermediates: intermediates, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	var inv x509.CertificateInvalidError
	if !errors.As(err, &inv) || inv.Reason != x509.TooManyIntermediates {
		t.Fatalf("a leaf under a CA forged with the cell CA's key: %v", err)
	}
}

func TestLeafIsAShortLivedServerCertificateForItsHostAlone(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	now := time.Now().Truncate(time.Second)
	ca.now = func() time.Time { return now }
	cert, err := ca.Leaf("api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	l := cert.Leaf
	if !slices.Equal(l.DNSNames, []string{"api.example.test"}) || len(l.IPAddresses)+len(l.EmailAddresses)+len(l.URIs) != 0 {
		t.Fatalf("leaf names: DNS %v, IP %v, email %v, URI %v", l.DNSNames, l.IPAddresses, l.EmailAddresses, l.URIs)
	}
	if l.IsCA || !l.BasicConstraintsValid || l.KeyUsage != x509.KeyUsageDigitalSignature || !slices.Equal(l.ExtKeyUsage, []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}) {
		t.Fatalf("leaf: CA %v, key usage %v, extended key usage %v", l.IsCA, l.KeyUsage, l.ExtKeyUsage)
	}
	if !l.NotBefore.Equal(now.Add(-time.Hour)) || !l.NotAfter.Equal(now.Add(30*24*time.Hour)) {
		t.Fatalf("leaf valid %v to %v, want 30 days from an hour before %v", l.NotBefore, l.NotAfter, now)
	}

	now = ca.Certificate().NotAfter.Add(-10 * 24 * time.Hour)
	late, err := ca.Leaf("api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	if !late.Leaf.NotAfter.Equal(ca.Certificate().NotAfter) {
		t.Fatalf("a leaf made 10 days before the CA expires ends %v, the CA %v", late.Leaf.NotAfter, ca.Certificate().NotAfter)
	}
}

func TestTheCAKeyIsNeverHandedOut(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	cert, err := ca.Leaf("api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	if k, ok := cert.PrivateKey.(*ecdsa.PrivateKey); !ok || k.Equal(ca.key) || ca.key.PublicKey.Equal(cert.Leaf.PublicKey) {
		t.Fatal("the leaf carries the CA's own key")
	}

	sec1, _ := x509.MarshalECPrivateKey(ca.key)
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(ca.key)
	d := ca.key.D.Bytes()
	forms := []string{ca.key.D.String(), ca.key.D.Text(16), hex.EncodeToString(d), base64.StdEncoding.EncodeToString(d),
		hex.EncodeToString(sec1), base64.StdEncoding.EncodeToString(sec1), base64.StdEncoding.EncodeToString(pkcs8)}
	j, jsonErr := json.Marshal(ca)
	_, refused := ca.Leaf("bank.example")
	outputs := []string{string(j), fmt.Sprint(jsonErr), string(ca.CertPEM()), fmt.Sprint(refused)}
	for _, verb := range []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%X", "%d"} {
		outputs = append(outputs, fmt.Sprintf(verb, ca), fmt.Sprintf(verb, cert))
	}
	for _, out := range outputs {
		for _, form := range forms {
			if strings.Contains(strings.ToLower(out), strings.ToLower(form)) {
				t.Fatalf("the CA key appears in %.80q", out)
			}
		}
	}
}

func TestConcurrentCallersShareOneLeafPerHost(t *testing.T) {
	ca, _ := New("cell-1", []string{"a.example.test", "b.example.test"})
	hosts := ca.Hosts()
	got := make([]*tls.Certificate, 64)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := range got {
		wg.Go(func() {
			<-start
			c, err := ca.Leaf(hosts[i%2])
			if err != nil {
				t.Error(err)
			}
			got[i] = c
		})
	}
	close(start)
	wg.Wait()
	if t.Failed() {
		return
	}
	for i, c := range got {
		if c != got[i%2] {
			t.Fatalf("caller %d got a second leaf for %s", i, hosts[i%2])
		}
	}
	if got[0] == got[1] || got[0].Leaf.DNSNames[0] != hosts[0] || got[1].Leaf.DNSNames[0] != hosts[1] {
		t.Fatal("the hosts' leaves are mixed up")
	}
}

func TestHostsAreExactlyTheNamesLeafServes(t *testing.T) {
	ca, _ := New("cell-1", []string{"b.example.test", "a.example.test", "b.example.test"})
	if got := ca.Hosts(); !slices.Equal(got, []string{"a.example.test", "b.example.test"}) {
		t.Fatalf("Hosts %v", got)
	}
	for _, h := range ca.Hosts() {
		if _, err := ca.Leaf(h); err != nil {
			t.Fatalf("Leaf(%q): %v", h, err)
		}
	}
	none, _ := New("cell-2", nil)
	if got := none.Hosts(); len(got) != 0 {
		t.Fatalf("a host-less CA lists %v", got)
	}
	if _, err := none.Leaf("invalid"); !errors.Is(err, ErrNotPermitted) {
		t.Fatalf("a host-less CA and its reserved constraint name: %v", err)
	}
}

func TestSerialsAreRandom127BitNumbersNeverReused(t *testing.T) {
	ca, _ := New("cell-1", []string{"a.example.test", "b.example.test", "c.example.test", "d.example.test"})
	now := time.Now()
	ca.now = func() time.Time { return now }
	serials := []*big.Int{ca.Certificate().SerialNumber}
	for range 10 {
		for _, h := range ca.Hosts() {
			cert, err := ca.Leaf(h)
			if err != nil {
				t.Fatal(err)
			}
			serials = append(serials, cert.Leaf.SerialNumber)
		}
		now = now.Add(leafLifetime)
	}
	// A uniform draw below 2^127 has 64 bits or fewer with odds of 2^-63, and all 41 draws miss the
	// top bit with odds of 2^-41.
	seen := map[string]bool{}
	widest := 0
	for _, s := range serials {
		if s.BitLen() <= 64 || s.BitLen() > 127 {
			t.Fatalf("serial %x has %d bits, want a random number below 2^127", s, s.BitLen())
		}
		if seen[s.String()] {
			t.Fatalf("serial %x issued twice", s)
		}
		seen[s.String()] = true
		widest = max(widest, s.BitLen())
	}
	if widest != 127 {
		t.Fatalf("the widest of %d serials has %d bits, want 127", len(serials), widest)
	}
}

func TestALeafIsRenewedExactlyADayBeforeItExpires(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	now := time.Now().Truncate(time.Second)
	ca.now = func() time.Time { return now }
	first, err := ca.Leaf("api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	now = first.Leaf.NotAfter.Add(-24*time.Hour - time.Second)
	if again, _ := ca.Leaf("api.example.test"); again != first {
		t.Fatal("a leaf was renewed more than a day before it expires")
	}
	now = first.Leaf.NotAfter.Add(-24 * time.Hour)
	if renewed, _ := ca.Leaf("api.example.test"); renewed == first {
		t.Fatal("a leaf a day from expiry was reused")
	}
}

func TestASingleHostCARefusesItsSubdomains(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	if err := verify(ca, forge(t, ca, []string{"x.api.example.test"}, nil), "x.api.example.test"); !notAuthorized(err) {
		t.Fatalf("a forged leaf for x.api.example.test: %v", err)
	}
}

func TestNewLowercasesItsHosts(t *testing.T) {
	hosts := []string{"Example.test", "api.example.test"}
	ca, err := New("cell-1", hosts)
	if err != nil {
		t.Fatal(err)
	}
	if hosts[0] != "Example.test" {
		t.Errorf("New changed its caller's hosts to %v", hosts)
	}
	for _, host := range []string{"example.test", "api.example.test"} {
		cert, err := ca.Leaf(host)
		if err != nil {
			t.Errorf("Leaf(%q): %v", host, err)
			continue
		}
		if err := verify(ca, cert.Leaf, host); err != nil {
			t.Errorf("the bound %s: %v", host, err)
		}
	}
	if got := ca.Hosts(); !slices.Equal(got, []string{"api.example.test", "example.test"}) {
		t.Errorf("Hosts %v", got)
	}
}

func TestSubdomainsOfFindsANestedHostInAnyCase(t *testing.T) {
	if got := subdomainsOf([]string{"Example.test", "api.example.test"}); !slices.Equal(got, []string{".api.example.test"}) {
		t.Fatalf("excluded names %v, want only the inner host's subdomains", got)
	}
}

func TestChangingTheReturnedCertificateChangesNothing(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	notAfter := ca.Certificate().NotAfter
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	c := ca.Certificate()
	c.PublicKey = other.Public()
	c.PermittedDNSDomains[0] = "bank.example"
	c.NotAfter = c.NotAfter.AddDate(10, 0, 0)
	c.Raw[0] ^= 0xff
	cert, err := ca.Leaf("api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	if err := verify(ca, cert.Leaf, "api.example.test"); err != nil {
		t.Fatal(err)
	}
	if got := ca.Certificate(); !got.NotAfter.Equal(notAfter) || !slices.Equal(got.PermittedDNSDomains, []string{"api.example.test"}) {
		t.Fatalf("the CA now ends %v and permits %v", got.NotAfter, got.PermittedDNSDomains)
	}
}
