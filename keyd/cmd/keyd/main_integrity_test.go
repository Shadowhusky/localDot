package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/egress"
)

func TestAnOldDaemonCannotCloseAReplacementSocket(t *testing.T) {
	home := shortHome(t)
	old, err := start(Config{Home: home, Vault: "memory", Ports: egress.PortRange{}})
	if err != nil {
		t.Fatal(err)
	}
	old.Close()
	fresh, err := start(Config{Home: home, Vault: "memory", Ports: egress.PortRange{}})
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	var calls sync.WaitGroup
	for range 8 {
		calls.Go(old.Close)
	}
	calls.Wait()
	if _, err := os.Stat(fresh.Socket); err != nil {
		t.Fatalf("old daemon removed replacement socket: %v", err)
	}
	code, status := adminCall(t, socketClient(fresh.Socket), "GET", "/v1/status", nil)
	if code != 200 || status["bootId"] != fresh.BootID {
		t.Fatalf("replacement unreachable: %d %v", code, status)
	}
}

func TestShutdownKeepsTheHomeLockUntilAdmittedHandlersFinish(t *testing.T) {
	home := shortHome(t)
	d, err := start(Config{Home: home, Vault: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var unblock sync.Once
	defer unblock.Do(func() { close(release) })
	go d.handle(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { close(entered); <-release })).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	<-entered
	closed := make(chan struct{})
	go func() { d.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("shutdown released its state while an admitted mutation still ran")
	case <-time.After(100 * time.Millisecond):
	}
	if next, err := start(Config{Home: home, Vault: "memory"}); err == nil {
		next.Close()
		t.Fatal("a second process acquired the state before the handler finished")
	}
	unblock.Do(func() { close(release) })
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not finish after the handler returned")
	}
	next, err := start(Config{Home: home, Vault: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	next.Close()
}

func TestShutdownInterruptsAnOpenEventStream(t *testing.T) {
	d, err := start(Config{Home: shortHome(t), Vault: "memory"})
	if err != nil {
		t.Fatal(err)
	}
	defer d.Close()
	client := socketClient(d.Socket)
	resp, err := client.Get("http://keyd/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	closed := make(chan struct{})
	go func() { d.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("event subscriber blocked shutdown")
	}
}

func TestStartupFailureReleasesItsLock(t *testing.T) {
	home := shortHome(t)
	dir := filepath.Join(home, "keyd")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if d, err := start(Config{Home: home, Vault: "memory"}); err == nil {
		d.Close()
		t.Fatal("bad settings allowed startup")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	d, err := start(Config{Home: home, Vault: "memory"})
	if err != nil {
		t.Fatalf("failed startup kept the lock: %v", err)
	}
	d.Close()
}
