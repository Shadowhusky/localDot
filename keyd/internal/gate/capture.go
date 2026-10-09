package gate

import (
	"bufio"
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

// Capture accepts the connections the gate redirected from the cell's programs and opens each one
// through keyd as a CONNECT, with the gate's own token. keyd decides; a refusal resets the program's
// connection, and a connection waiting for the user stays open with nothing sent either way.
type Capture struct {
	// Keyd is the cell's keyd listener, host:port.
	Keyd  string
	Token string
	// Self is the gate's own address on the cell's network: a connection to it was not redirected.
	Self netip.Addr
	Pool *Pool
	// Original is where the program meant to connect (SO_ORIGINAL_DST on Linux).
	Original func(net.Conn) (netip.AddrPort, error)
	Dial     func(ctx context.Context, network, address string) (net.Conn, error)
	// Answer bounds the wait for keyd's reply, which includes the user's answer.
	Answer time.Duration
	// Limit bounds the connections handled at once.
	Limit int
}

const sourceHeader = "X-Localdot-Source"

func (c *Capture) Serve(ln net.Listener) error {
	slots := make(chan struct{}, max(c.Limit, 1))
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		select {
		case slots <- struct{}{}:
			go func() {
				defer func() { <-slots }()
				c.handle(conn)
			}()
		default:
			reset(conn)
		}
	}
}

type firstRead struct {
	data []byte
	err  error
}

func (c *Capture) handle(client net.Conn) {
	target, ok := c.target(client)
	if !ok {
		reset(client)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	up, err := c.Dial(ctx, "tcp", c.Keyd)
	cancel()
	if err != nil {
		reset(client)
		return
	}
	request := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\nProxy-Authorization: Basic " +
		base64.StdEncoding.EncodeToString([]byte("gate:"+c.Token)) + "\r\n"
	if port := portOf(client.RemoteAddr()); port != 0 {
		request += sourceHeader + ": " + strconv.Itoa(port) + "\r\n"
	}
	if _, err := io.WriteString(up, request+"\r\n"); err != nil {
		up.Close()
		reset(client)
		return
	}
	// The program may give up, or speak first, while keyd waits for the user: either is seen here.
	first := make(chan firstRead, 1)
	go func() {
		buf := make([]byte, 32<<10)
		n, err := client.Read(buf)
		first <- firstRead{buf[:n], err}
	}()
	replied := make(chan *bufio.Reader, 1)
	go func() {
		up.SetReadDeadline(time.Now().Add(c.Answer))
		br := bufio.NewReader(up)
		resp, err := http.ReadResponse(br, &http.Request{Method: http.MethodConnect})
		if err != nil || resp.StatusCode != http.StatusOK {
			replied <- nil
			return
		}
		up.SetReadDeadline(time.Time{})
		replied <- br
	}()
	var early *firstRead
	var br *bufio.Reader
	select {
	case br = <-replied:
	case f := <-first:
		if f.err != nil {
			up.Close()
			client.Close()
			<-replied
			return
		}
		early = &f
		br = <-replied
	}
	if br == nil {
		up.Close()
		reset(client)
		return
	}
	// keyd's tunnel ends both ways at once, so the first side to end closes both here too: a Stop
	// that cuts the tunnel cuts the program's connection.
	var once sync.Once
	end := func() {
		once.Do(func() {
			up.Close()
			client.Close()
		})
	}
	go func() {
		defer end()
		f := early
		if f == nil {
			got := <-first
			f = &got
		}
		if len(f.data) > 0 {
			if _, err := up.Write(f.data); err != nil {
				return
			}
		}
		if f.err == nil {
			io.Copy(up, client)
		}
	}()
	io.Copy(client, br)
	end()
}

// target is the CONNECT authority for a redirected connection: the name behind a placeholder, or
// the address the program used. A placeholder the pool no longer knows has no destination.
func (c *Capture) target(client net.Conn) (string, bool) {
	dst, err := c.Original(client)
	if err != nil || !dst.Addr().Is4() || dst.Addr() == c.Self || dst.Port() == 0 {
		return "", false
	}
	host := dst.Addr().String()
	if Placeholders.Contains(dst.Addr()) {
		name, ok := c.Pool.Name(dst.Addr())
		if !ok {
			return "", false
		}
		host = name
	}
	return net.JoinHostPort(host, strconv.Itoa(int(dst.Port()))), true
}

func portOf(a net.Addr) int {
	if t, ok := a.(*net.TCPAddr); ok {
		return t.Port
	}
	return 0
}

// reset refuses with a TCP reset, so the program sees the connection refused rather than ended.
func reset(conn net.Conn) {
	if t, ok := conn.(*net.TCPConn); ok {
		t.SetLinger(0)
	}
	conn.Close()
}
