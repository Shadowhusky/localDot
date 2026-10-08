package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/admin"
)

func managedIdentityFixture() admin.ServiceIdentity {
	return admin.ServiceIdentity{OwnerID: strings.Repeat("e", 32), Release: admin.ReleaseIdentity{
		Version: "1.2.3-rc.1", PackageSHA256: strings.Repeat("a", 64), ManifestSHA256: strings.Repeat("b", 64),
	}}
}

func TestManagedServiceEnvironment(t *testing.T) {
	value, err := managedServiceFromEnv(func(string) (string, bool) { return "", false })
	if value != nil || err != nil {
		t.Fatal("unmanaged mode changed")
	}
	if _, err := managedServiceFromEnv(func(string) (string, bool) { return "", true }); err == nil {
		t.Fatal("an explicitly empty identity must not become unmanaged mode")
	}
	expected := managedIdentityFixture()
	raw, _ := json.Marshal(expected)
	value, err = managedServiceFromEnv(func(name string) (string, bool) {
		if name != "LOCALDOT_SERVICE_IDENTITY" {
			t.Fatal("unexpected environment lookup")
		}
		return string(raw), true
	})
	if err != nil || value == nil || *value != expected {
		t.Fatal("identity not passed through")
	}
}

func TestManagedServiceRejectsInvalidBeforeState(t *testing.T) {
	home := filepath.Join(t.TempDir(), "absent")
	if _, err := start(Config{Home: home, Vault: "memory", Service: &admin.ServiceIdentity{}}); err == nil {
		t.Fatal("invalid service accepted")
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatal("invalid identity wrote state")
	}
}

// Only a private temporary Unix socket, memory vault, and zero-value (off) network discovery.
func TestManagedServiceStatus(t *testing.T) {
	expected := managedIdentityFixture()
	input := expected
	d, err := start(Config{Home: shortHome(t), Vault: "memory", Service: &input})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	input.OwnerID = strings.Repeat("f", 32)
	code, status := adminCall(t, socketClient(d.Socket), "GET", "/v1/status", nil)
	raw, _ := json.Marshal(status["service"])
	var got admin.ServiceProcessIdentity
	if err := json.Unmarshal(raw, &got); err != nil || code != 200 ||
		got.ServiceIdentity != expected || got.PID != os.Getpid() || status["bootId"] != d.BootID {
		t.Fatalf("managed status identity mismatch: %v", err)
	}
}
