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
	"strings"
	"sync"
	"time"
)

var ErrNotPermitted = errors.New("cellca: not one of this cell's intercepted hosts")

var errEmptyHost = errors.New("cellca: an empty host would permit every name")

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
	if slices.Contains(hosts, "") {
		return nil, errEmptyHost
	}
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
		ExcludedDNSDomains:          subdomainsOf(hosts),
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

// subdomainsOf names the subdomains of each host for exclusion, since a permitted DNS name also
// covers its subdomains. A host with another host beneath it keeps its subdomains: exclusions win,
// so excluding them would refuse that host too.
func subdomainsOf(hosts []string) []string {
	var out []string
	for _, h := range hosts {
		if !slices.ContainsFunc(hosts, func(o string) bool { return strings.HasSuffix(o, "."+h) }) {
			out = append(out, "."+h)
		}
	}
	return out
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
