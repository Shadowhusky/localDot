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
	// Self is the gate's end of the desktop's link (192.0.0.1, cells/gate/link.sh): a connection
	// to it was not redirected.
	Self netip.Addr
	Pool *Pool
	// Original is where the program meant to connect (SO_ORIGINAL_DST on Linux).
	Original func(net.Conn) (netip.AddrPort, error)
	Dial     func(ctx context.Context, network, address string) (net.Conn, error)
	// Answer bounds the wait for keyd's reply, which includes the user's answer.
	Answer time.Duration
	// Limit bounds the connections handled at once.
	Limit int
	// Sniff bounds the wait for a program that connected to an address to say what name it means,
	// in its TLS server name or HTTP Host; keyd is then asked about that name instead.
	Sniff time.Duration
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
	target, named, ok := c.target(client)
	if !ok {
		reset(client)
		return
	}
	var early *firstRead
	if !named {
		start, err := c.sniff(client)
		if len(start) > 0 || err != nil {
			early = &firstRead{start, err}
		}
		if len(start) == 0 && err != nil {
			client.Close()
			return
		}
		if name, _ := Named(start); name != "" {
			if host, ok := Reachable(name); ok {
				_, port, _ := net.SplitHostPort(target)
				target = net.JoinHostPort(host, port)
			}
		}
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
	if early == nil {
		go func() {
			buf := make([]byte, 32<<10)
			n, err := client.Read(buf)
			first <- firstRead{buf[:n], err}
		}()
	}
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
	var br *bufio.Reader
	if early != nil {
		br = <-replied
	} else {
		select {
		case br = <-replied:
		case f := <-first:
			if f.err != nil && (f.err != io.EOF || len(f.data) == 0) {
				up.Close()
				client.Close()
				<-replied
				return
			}
			early = &f
			br = <-replied
		}
	}
	if br == nil {
		up.Close()
		reset(client)
		return
	}
	// The app may half-close an upload before receiving its acknowledgement. Propagate that
	// sending-side EOF without dropping the reply. A keyd cut still closes the app immediately.
	var once sync.Once
	end := func() {
		once.Do(func() {
			up.Close()
			client.Close()
		})
	}
	go func() {
		f := early
		if f == nil {
			got := <-first
			f = &got
		}
		if len(f.data) > 0 {
			if _, err := up.Write(f.data); err != nil {
				end()
				return
			}
		}
		err := f.err
		if err == nil {
			_, err = io.Copy(up, client)
		}
		if err == nil || err == io.EOF {
			if writer, ok := up.(interface{ CloseWrite() error }); ok && writer.CloseWrite() == nil {
				return
			}
		}
		end()
	}()
	io.Copy(client, br)
	end()
}

// target is the CONNECT authority for a redirected connection: the name behind a placeholder, or
// the address the program used, and whether it is a name. A placeholder the pool no longer knows
// has no destination.
func (c *Capture) target(client net.Conn) (string, bool, bool) {
	dst, err := c.Original(client)
	if err != nil || !dst.Addr().Is4() || dst.Addr() == c.Self || dst.Port() == 0 {
		return "", false, false
	}
	port := strconv.Itoa(int(dst.Port()))
	if Placeholders.Contains(dst.Addr()) {
		name, ok := c.Pool.Name(dst.Addr())
		return net.JoinHostPort(name, port), true, ok
	}
	return net.JoinHostPort(dst.Addr().String(), port), false, true
}

// sniff reads what a program sends first, for as long as it may still name its destination and
// at most Sniff. A program that waits for the server to speak first sends nothing in that time.
func (c *Capture) sniff(client net.Conn) ([]byte, error) {
	if c.Sniff <= 0 {
		return nil, nil
	}
	client.SetReadDeadline(time.Now().Add(c.Sniff))
	defer client.SetReadDeadline(time.Time{})
	var start []byte
	buf := make([]byte, maxSniff)
	for len(start) < maxSniff {
		n, err := client.Read(buf[:maxSniff-len(start)])
		start = append(start, buf[:n]...)
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			return start, nil
		}
		if err != nil {
			return start, err
		}
		if _, more := Named(start); !more {
			break
		}
	}
	return start, nil
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
