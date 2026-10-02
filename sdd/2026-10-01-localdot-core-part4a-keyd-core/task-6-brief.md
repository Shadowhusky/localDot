### Task 6: The per-cell CA — name-constrained, in memory only

Selective interception needs a CA the cell trusts that can vouch only for the hosts keyd
intercepts for that cell. S4 proved Chromium enforces such constraints ("Not permitted by name
constraints"). The CA is an EC P-256 key that never leaves keyd's memory, with critical name
constraints permitting exactly the cell's bound hosts (or the reserved name `invalid` when it has
none), every IP range excluded, a path length of zero and server authentication as its only
extended key usage, so a stolen key could not sign a client, mail or code-signing certificate
either (review 1, M8). `Leaf` refuses any host outside that set
even though the X.509 subtree rule would allow its subdomains; keyd is stricter than the
constraint. The tests forge leaves with the CA's own key, as a thief would, and show that Go's
verifier rejects them.

**Files:**
- Create: `keyd/internal/cellca/cellca.go`
- Test: `keyd/internal/cellca/cellca_test.go`

**Interfaces:**
- Produces: `New(cellID string, hosts []string) (*CA, error)`, `(*CA).Certificate() *x509.Certificate`,
  `(*CA).CertPEM() []byte` (one `CERTIFICATE` block), `(*CA).Hosts() []string` (sorted),
  `(*CA).Leaf(host string) (*tls.Certificate, error)` (cached; renewed a day before it expires;
  `ErrNotPermitted` for any other host). Lifetimes: CA 397 days, leaves 30 days, both starting an
  hour back for clock skew. The CA's `ExtKeyUsage` is `[ServerAuth]`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/cellca/cellca_test.go`:
```go
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/cellca/`
Expected: FAIL — `[build failed]`, starting `internal/cellca/cellca_test.go:18:15: undefined: CA`.

- [ ] **Step 3: Implement the CA**

`keyd/internal/cellca/cellca.go`:
```go
// Package cellca is a cell's own certificate authority: an EC P-256 key that exists only in
// keyd's memory and an X.509 name constraint that limits it to the hosts keyd intercepts for that
// cell, so even a stolen key could not impersonate any other site, nor sign anything but a server
// certificate.
package cellca

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"slices"
	"sync"
	"time"
)

var ErrNotPermitted = errors.New("cellca: not one of this cell's intercepted hosts")

const (
	caLifetime   = 397 * 24 * time.Hour
	leafLifetime = 30 * 24 * time.Hour
	renewBefore  = 24 * time.Hour
)

type CA struct {
	cert    *x509.Certificate
	certPEM []byte
	key     *ecdsa.PrivateKey
	leafKey *ecdsa.PrivateKey
	hosts   map[string]bool
	now     func() time.Time
	mu      sync.Mutex
	leaves  map[string]*tls.Certificate
}

// New makes a CA permitted to vouch only for hosts. With no hosts it is constrained to the
// reserved name "invalid", so it can vouch for nothing real.
func New(cellID string, hosts []string) (*CA, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	permitted := slices.Clone(hosts)
	if len(permitted) == 0 {
		permitted = []string{"invalid"}
	}
	unit := cellID
	if len(unit) > 64 {
		unit = unit[:64]
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:                serial(),
		Subject:                     pkix.Name{CommonName: "localDot cell CA", Organization: []string{"localDot"}, OrganizationalUnit: []string{unit}},
		NotBefore:                   now.Add(-time.Hour),
		NotAfter:                    now.Add(caLifetime),
		IsCA:                        true,
		BasicConstraintsValid:       true,
		MaxPathLen:                  0,
		MaxPathLenZero:              true,
		KeyUsage:                    x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		ExtKeyUsage:                 []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		PermittedDNSDomainsCritical: true,
		PermittedDNSDomains:         permitted,
		ExcludedIPRanges: []*net.IPNet{
			{IP: net.IP{0, 0, 0, 0}, Mask: net.CIDRMask(0, 32)},
			{IP: net.IPv6zero, Mask: net.CIDRMask(0, 128)},
		},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, h := range hosts {
		allowed[h] = true
	}
	return &CA{
		cert:    cert,
		certPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		key:     key,
		leafKey: leafKey,
		hosts:   allowed,
		now:     time.Now,
		leaves:  map[string]*tls.Certificate{},
	}, nil
}

func (ca *CA) Certificate() *x509.Certificate { return ca.cert }

// CertPEM is the public certificate the cell installs as a trust anchor.
func (ca *CA) CertPEM() []byte { return slices.Clone(ca.certPEM) }

// Hosts are the exact hosts this CA serves leaves for, sorted.
func (ca *CA) Hosts() []string {
	out := make([]string, 0, len(ca.hosts))
	for h := range ca.hosts {
		out = append(out, h)
	}
	slices.Sort(out)
	return out
}

// Leaf returns a server certificate for host, minting or renewing it as needed.
func (ca *CA) Leaf(host string) (*tls.Certificate, error) {
	if !ca.hosts[host] {
		return nil, ErrNotPermitted
	}
	ca.mu.Lock()
	defer ca.mu.Unlock()
	now := ca.now()
	if c, ok := ca.leaves[host]; ok && now.Before(c.Leaf.NotAfter.Add(-renewBefore)) {
		return c, nil
	}
	notAfter := now.Add(leafLifetime)
	if notAfter.After(ca.cert.NotAfter) {
		notAfter = ca.cert.NotAfter
	}
	tmpl := &x509.Certificate{
		SerialNumber:          serial(),
		Subject:               pkix.Name{CommonName: host},
		DNSNames:              []string{host},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &ca.leafKey.PublicKey, ca.key)
	if err != nil {
		return nil, err
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return nil, err
	}
	c := &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: ca.leafKey, Leaf: leaf}
	ca.leaves[host] = c
	return c, nil
}

func serial() *big.Int {
	n, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		panic(err)
	}
	return n
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/cellca/`
Expected: `ok` (9 tests). The forged-leaf tests fail verification with
`x509: a root or intermediate certificate is not authorized to sign for this name`.

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/cellca
git commit -m "feat(keyd): per-cell name-constrained CA"
```

---
