package egress

import (
	"net"
	"sync"
)

// The slot follows a connection through HTTP and CONNECT hijacking; only Close returns it.
type limitedListener struct {
	net.Listener
	slots   chan struct{}
	refused func()
}

func (l *limitedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &limitedConn{Conn: conn, release: func() { <-l.slots }}, nil
		default:
			conn.Close()
			l.refused()
		}
	}
}

type limitedConn struct {
	net.Conn
	release func()
	once    sync.Once
	err     error
}

func (c *limitedConn) Close() error {
	c.once.Do(func() { c.err = c.Conn.Close(); c.release() })
	return c.err
}
