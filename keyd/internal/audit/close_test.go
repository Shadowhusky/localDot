package audit

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCloseImmediatelyRefusesCredentialAdmission(t *testing.T) {
	log, err := Open(filepath.Join(t.TempDir(), "audit.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if log.Err() != nil {
		t.Fatal("fresh log unavailable")
	}
	if err := log.Close(); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(log.Err(), os.ErrClosed) {
		t.Fatal("closed log still advertises readiness")
	}
	called := false
	log.OnWrite(func(Line) { called = true })
	if _, err := log.Write(Line{Kind: KindRequest, Decision: Allow}); err == nil {
		t.Fatal("closed write passed")
	}
	if log.Err() == nil || called {
		t.Fatal("failed write reopened audit readiness")
	}
	_ = log.Close()
	if !errors.Is(log.Err(), os.ErrClosed) {
		t.Fatal("repeated close cleared failure")
	}
}
