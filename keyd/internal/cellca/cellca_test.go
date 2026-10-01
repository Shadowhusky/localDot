package cellca

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"testing"
	"time"
)

func pool(ca *CA) *x509.CertPool {
	p := x509.NewCertPool()
	p.AddCert(ca.Certificate())
	return p
}

func verify(ca *CA, leaf *x509.Certificate, host string) error {
	_, err := leaf.Verify(x509.VerifyOptions{DNSName: host, Roots: pool(ca), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
	return err
}

func notAuthorized(err error) bool {
	var inv x509.CertificateInvalidError
	return errors.As(err, &inv) && inv.Reason == x509.CANotAuthorizedForThisName
}

// forge signs a leaf with the CA's own key, as a stolen key would; it is a server certificate
// unless usages say otherwise.
func forge(t *testing.T, ca *CA, dns []string, ips []net.IP, usages ...x509.ExtKeyUsage) *x509.Certificate {
	t.Helper()
	if len(usages) == 0 {
		usages = []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}
	}
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(99),
		Subject:      pkix.Name{CommonName: "forged"},
		DNSNames:     dns,
		IPAddresses:  ips,
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  usages,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return cert
}

func TestNewIsAConstrainedCA(t *testing.T) {
	ca, err := New("cell-1", []string{"api.example.test", "postman-echo.com"})
	if err != nil {
		t.Fatal(err)
	}
	c := ca.Certificate()
	if !c.IsCA || !c.MaxPathLenZero || c.MaxPathLen != 0 || !c.PermittedDNSDomainsCritical {
		t.Fatalf("CA flags: IsCA %v MaxPathLenZero %v critical %v", c.IsCA, c.MaxPathLenZero, c.PermittedDNSDomainsCritical)
	}
	if len(c.PermittedDNSDomains) != 2 || c.PermittedDNSDomains[0] != "api.example.test" {
		t.Fatalf("permitted %v", c.PermittedDNSDomains)
	}
	if len(c.ExcludedIPRanges) != 2 {
		t.Fatalf("excluded IP ranges %v, want all of IPv4 and IPv6", c.ExcludedIPRanges)
	}
	if _, ok := c.PublicKey.(*ecdsa.PublicKey); !ok {
		t.Fatalf("CA key %T, want ECDSA P-256", c.PublicKey)
	}
}

func TestLeafVerifiesForAPermittedHost(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	cert, err := ca.Leaf("api.example.test")
	if err != nil {
		t.Fatal(err)
	}
	if err := verify(ca, cert.Leaf, "api.example.test"); err != nil {
		t.Fatal(err)
	}
	if cert.Leaf.NotAfter.After(ca.Certificate().NotAfter) {
		t.Fatal("leaf outlives its CA")
	}
}

func TestLeafRefusesHostsOutsideTheConstraints(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	for _, host := range []string{"example.com", "evil.test", "x.api.example.test", ""} {
		if _, err := ca.Leaf(host); !errors.Is(err, ErrNotPermitted) {
			t.Errorf("Leaf(%q) err = %v, want ErrNotPermitted", host, err)
		}
	}
}

func TestVerifiersRejectForgedLeavesOutsideTheConstraints(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	if err := verify(ca, forge(t, ca, []string{"bank.example"}, nil), "bank.example"); !notAuthorized(err) {
		t.Fatalf("forged leaf for an unlisted name: %v", err)
	}
	if err := verify(ca, forge(t, ca, nil, []net.IP{net.ParseIP("93.184.215.14")}), "93.184.215.14"); !notAuthorized(err) {
		t.Fatalf("forged leaf for an IP address: %v", err)
	}
}

func TestTheCAVouchesOnlyForServers(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	if eku := ca.Certificate().ExtKeyUsage; len(eku) != 1 || eku[0] != x509.ExtKeyUsageServerAuth {
		t.Fatalf("CA extended key usage %v, want server auth only", eku)
	}
	for _, usage := range []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageCodeSigning, x509.ExtKeyUsageEmailProtection} {
		leaf := forge(t, ca, []string{"api.example.test"}, nil, usage)
		_, err := leaf.Verify(x509.VerifyOptions{DNSName: "api.example.test", Roots: pool(ca), KeyUsages: []x509.ExtKeyUsage{usage}})
		var inv x509.CertificateInvalidError
		if !errors.As(err, &inv) || inv.Reason != x509.IncompatibleUsage {
			t.Errorf("a forged leaf for usage %v: %v", usage, err)
		}
	}
}

func TestACellWithoutHostsCanVouchForNothingReal(t *testing.T) {
	ca, err := New("cell-2", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := ca.Certificate().PermittedDNSDomains; len(got) != 1 || got[0] != "invalid" {
		t.Fatalf("permitted %v, want [invalid]", got)
	}
	if err := verify(ca, forge(t, ca, []string{"example.com"}, nil), "example.com"); !notAuthorized(err) {
		t.Fatalf("a host-less CA and example.com: %v", err)
	}
}

func TestLeavesAreCachedAndRenewed(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	now := time.Now()
	ca.now = func() time.Time { return now }
	a, _ := ca.Leaf("api.example.test")
	b, _ := ca.Leaf("api.example.test")
	if a != b {
		t.Fatal("second Leaf minted a new certificate")
	}
	now = a.Leaf.NotAfter.Add(-12 * time.Hour)
	c, _ := ca.Leaf("api.example.test")
	if c == a {
		t.Fatal("a leaf about to expire was reused")
	}
}

func TestCellsDoNotShareKeys(t *testing.T) {
	a, _ := New("cell-a", []string{"api.example.test"})
	b, _ := New("cell-b", []string{"api.example.test"})
	leaf, _ := a.Leaf("api.example.test")
	if err := verify(b, leaf.Leaf, "api.example.test"); err == nil {
		t.Fatal("cell b's CA accepted cell a's leaf")
	}
}

func TestCertPEMHoldsOnlyTheCertificate(t *testing.T) {
	ca, _ := New("cell-1", []string{"api.example.test"})
	pemBytes := ca.CertPEM()
	block, rest := pem.Decode(pemBytes)
	if block == nil || block.Type != "CERTIFICATE" || len(bytes.TrimSpace(rest)) != 0 {
		t.Fatalf("CertPEM is not exactly one certificate: %s", pemBytes)
	}
	if bytes.Contains(pemBytes, []byte("PRIVATE")) {
		t.Fatal("CertPEM mentions a private key")
	}
	parsed, _ := x509.ParseCertificate(block.Bytes)
	if !parsed.Equal(ca.Certificate()) {
		t.Fatal("CertPEM is not the CA certificate")
	}
}
