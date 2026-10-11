package gate

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// Run inside the gate image: this covers the third relay hop, including socat's
// half-close grace period, without reaching any external service.
func TestSocatDelayedUploadReceipt(t *testing.T) {
	if _, err := exec.LookPath("socat"); err != nil {
		t.Skip("socat is installed in the gate image")
	}
	script, err := os.ReadFile("/relay.sh")
	if err != nil {
		t.Skip("run inside the gate image with /relay.sh")
	}
	if !strings.Contains(string(script), "socat -t60 \"TCP4-LISTEN:3128") {
		t.Fatal("outbound relay must allow delayed upload acknowledgements")
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	listener.Close()
	result := make(chan error, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			result <- err
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		body, err := io.ReadAll(c)
		if err == nil && string(body) != "file contents" {
			err = fmt.Errorf("wrong payload %q", body)
		}
		if err == nil {
			time.Sleep(time.Second)
			_, err = io.WriteString(c, "upload accepted")
		}
		result <- err
	}()
	cmd := exec.Command("socat", "-t60", "TCP4-LISTEN:"+strings.Split(addr, ":")[1]+",bind=127.0.0.1,reuseaddr", "TCP4:"+ln.Addr().String())
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	var c net.Conn
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); {
		c, err = net.DialTimeout("tcp4", addr, 100*time.Millisecond)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(c, "file contents")
	c.(*net.TCPConn).CloseWrite()
	got, err := io.ReadAll(c)
	if err != nil || string(got) != "upload accepted" {
		t.Fatalf("receipt %q, %v", got, err)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}
