package gate

import (
	"bufio"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const token = "capture-token-0123456789abcdefghijklmnopqrs"

// fakeKeyd records each CONNECT and answers it with what decide returns; a 200 is followed by an
// echo of the tunnel.
type fakeKeyd struct {
	ln       net.Listener
	requests chan *http.Request
	closed   chan struct{}
	// cut ends one open tunnel from keyd's side, as Stop does.
	cut    chan struct{}
	decide func(*http.Request) (int, time.Duration)
}

func newFakeKeyd(t *testing.T, decide func(*http.Request) (int, time.Duration)) *fakeKeyd {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	k := &fakeKeyd{ln: ln, requests: make(chan *http.Request, 8), closed: make(chan struct{}, 8), cut: make(chan struct{}), decide: decide}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go k.serve(conn)
		}
	}()
	return k
}

func (k *fakeKeyd) serve(conn net.Conn) {
	defer conn.Close()
	br := bufio.NewReader(conn)
	req, err := http.ReadRequest(br)
	if err != nil {
		return
	}
	k.requests <- req
	status, wait := k.decide(req)
	if status == 0 {
		// Never answered: a capture that gave up closes its side while keyd still waits.
		if _, err := br.Peek(1); err != nil {
			k.closed <- struct{}{}
		}
		return
	}
	time.Sleep(wait)
	io.WriteString(conn, "HTTP/1.1 "+strconv.Itoa(status)+" "+http.StatusText(status)+"\r\n\r\n")
	if status == http.StatusOK {
		go io.Copy(conn, br)
		<-k.cut
	}
}

type fixture struct {
	capture *Capture
	ln      net.Listener
	mu      sync.Mutex
	dst     netip.AddrPort
}

func (f *fixture) to(dst netip.AddrPort) {
	f.mu.Lock()
	f.dst = dst
	f.mu.Unlock()
}

func newCapture(t *testing.T, k *fakeKeyd, dst netip.AddrPort) *fixture {
	t.Helper()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	f := &fixture{ln: ln, dst: dst}
	var d net.Dialer
	f.capture = &Capture{
		Keyd: k.ln.Addr().String(), Token: token, Self: netip.MustParseAddr("10.9.0.10"), Pool: NewPool(),
		Original: func(net.Conn) (netip.AddrPort, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			if !f.dst.IsValid() {
				return netip.AddrPort{}, errors.New("not redirected")
			}
			return f.dst, nil
		},
		Dial: d.DialContext, Answer: 2 * time.Second, Limit: 8, Sniff: 300 * time.Millisecond,
	}
	go f.capture.Serve(ln)
	return f
}

func (f *fixture) dial(t *testing.T) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp4", f.ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	return conn
}

// refusedAtOnce dials and expects a reset, which can arrive before the dial returns.
func (f *fixture) refusedAtOnce(t *testing.T) {
	t.Helper()
	conn, err := net.Dial("tcp4", f.ln.Addr().String())
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	refused(t, conn)
}

func refused(t *testing.T, conn net.Conn) {
	t.Helper()
	if _, err := conn.Read(make([]byte, 1)); err == nil {
		t.Fatal("the connection was not refused")
	} else if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("the connection stayed open")
	}
}

func TestACapturedConnectionAsksKeydForTheNameBehindItsPlaceholder(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return http.StatusOK, 0 })
	f := newCapture(t, k, netip.AddrPort{})
	f.to(netip.AddrPortFrom(f.capture.Pool.Addr("chat.example.com"), 5222))
	conn := f.dial(t)
	req := <-k.requests
	if req.Method != http.MethodConnect || req.Host != "chat.example.com:5222" {
		t.Fatalf("request %s %s", req.Method, req.Host)
	}
	if req.Header.Get("Proxy-Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("gate:"+token)) {
		t.Fatalf("authorization %q", req.Header.Get("Proxy-Authorization"))
	}
	if req.Header.Get(sourceHeader) != strconv.Itoa(conn.LocalAddr().(*net.TCPAddr).Port) {
		t.Fatalf("source %q", req.Header.Get(sourceHeader))
	}
	io.WriteString(conn, "ping\n")
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != "ping\n" {
		t.Fatalf("echo %q %v", line, err)
	}
}

func TestAnAddressIsAskedForAsItIs(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return http.StatusForbidden, 0 })
	f := newCapture(t, k, netip.MustParseAddrPort("93.184.216.34:8080"))
	conn := f.dial(t)
	if req := <-k.requests; req.Host != "93.184.216.34:8080" {
		t.Fatalf("host %q", req.Host)
	}
	refused(t, conn)
}

func TestWhatHasNoDestinationIsRefusedWithoutKeyd(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return http.StatusOK, 0 })
	f := newCapture(t, k, netip.AddrPort{})
	for _, dst := range []netip.AddrPort{
		netip.MustParseAddrPort("198.18.3.3:443"),   // a placeholder nobody was given
		netip.MustParseAddrPort("10.9.0.10:3130"),   // the gate itself
		netip.MustParseAddrPort("[2001:db8::1]:80"), // the cell has no IPv6
	} {
		f.to(dst)
		f.refusedAtOnce(t)
	}
	f.to(netip.AddrPort{})
	f.refusedAtOnce(t)
	select {
	case req := <-k.requests:
		t.Fatalf("keyd was asked for %s", req.Host)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestAProgramThatGivesUpWithdrawsItsQuestion(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return 0, 0 })
	f := newCapture(t, k, netip.MustParseAddrPort("93.184.216.34:5222"))
	conn := f.dial(t)
	<-k.requests
	conn.Close()
	select {
	case <-k.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("keyd's connection stayed open")
	}
}

func TestAProgramThatSpeaksFirstIsHeardOnceAllowed(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return http.StatusOK, 300 * time.Millisecond })
	f := newCapture(t, k, netip.MustParseAddrPort("93.184.216.34:6667"))
	conn := f.dial(t)
	io.WriteString(conn, "NICK dot\n")
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || line != "NICK dot\n" {
		t.Fatalf("echo %q %v", line, err)
	}
}

func TestKeydClosingTheTunnelClosesTheProgramsConnection(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return http.StatusOK, 0 })
	f := newCapture(t, k, netip.MustParseAddrPort("93.184.216.34:5222"))
	conn := f.dial(t)
	<-k.requests
	io.WriteString(conn, "x")
	if _, err := conn.Read(make([]byte, 1)); err != nil {
		t.Fatal(err)
	}
	k.cut <- struct{}{}
	refused(t, conn)
}

func TestAnAddressIsAskedForByTheNameItsTLSOrHTTPGives(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return http.StatusOK, 0 })
	f := newCapture(t, k, netip.MustParseAddrPort("93.184.216.34:443"))
	conn := f.dial(t)
	go tls.Client(conn, &tls.Config{ServerName: "Chat.Example.com", InsecureSkipVerify: true}).Handshake()
	if req := <-k.requests; req.Host != "chat.example.com:443" {
		t.Fatalf("host %q", req.Host)
	}
	f.to(netip.MustParseAddrPort("93.184.216.34:80"))
	conn = f.dial(t)
	request := "GET / HTTP/1.1\r\nHost: www.example.com:80\r\nAccept: */*\r\n\r\n"
	io.WriteString(conn, request)
	if req := <-k.requests; req.Host != "www.example.com:80" {
		t.Fatalf("host %q", req.Host)
	}
	// What the program sent while the gate listened reaches the tunnel first.
	got := make([]byte, len(request))
	if _, err := io.ReadFull(conn, got); err != nil || string(got) != request {
		t.Fatalf("echo %q %v", got, err)
	}
}

func TestANameKeydRefusesByNameLeavesTheAddress(t *testing.T) {
	k := newFakeKeyd(t, func(*http.Request) (int, time.Duration) { return http.StatusForbidden, 0 })
	f := newCapture(t, k, netip.MustParseAddrPort("93.184.216.34:80"))
	conn := f.dial(t)
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: printer.local\r\n\r\n")
	if req := <-k.requests; req.Host != "93.184.216.34:80" {
		t.Fatalf("host %q", req.Host)
	}
	refused(t, conn)
}

func TestCapturedUploadRetainsReceiptAfterHalfClose(t *testing.T) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	payload := strings.Repeat("file-data", 32768)
	serverResult := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			serverResult <- err
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(2 * time.Second))
		br := bufio.NewReader(conn)
		_, err = http.ReadRequest(br)
		if err != nil {
			serverResult <- err
			return
		}
		io.WriteString(conn, "HTTP/1.1 200 Connection established\r\n\r\n")
		got, err := io.ReadAll(br)
		if err == nil && string(got) != payload {
			err = fmt.Errorf("upload truncated: %d bytes", len(got))
		}
		if err == nil {
			_, err = io.WriteString(conn, "upload accepted")
		}
		serverResult <- err
	}()
	f := newCapture(t, &fakeKeyd{ln: ln}, netip.MustParseAddrPort("93.184.216.34:443"))
	app := f.dial(t).(*net.TCPConn)
	go func() { io.WriteString(app, payload); app.CloseWrite() }()
	receipt, err := io.ReadAll(app)
	if err != nil || string(receipt) != "upload accepted" {
		t.Errorf("receipt: %q, %v", receipt, err)
	}
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
}
