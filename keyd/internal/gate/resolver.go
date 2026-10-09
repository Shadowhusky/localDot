package gate

import (
	"encoding/binary"
	"io"
	"net"
	"time"
)

// ServeUDP answers DNS queries on pc until it is closed.
func ServeUDP(pc net.PacketConn, pool *Pool) error {
	buf := make([]byte, 1500)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return err
		}
		if out, err := Answer(buf[:n], pool); err == nil {
			pc.WriteTo(out, from)
		}
	}
}

// ServeTCP answers length-prefixed DNS queries, as resolvers send them over TCP.
func ServeTCP(ln net.Listener, pool *Pool) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go func() {
			defer conn.Close()
			for {
				conn.SetDeadline(time.Now().Add(10 * time.Second))
				var size [2]byte
				if _, err := io.ReadFull(conn, size[:]); err != nil {
					return
				}
				query := make([]byte, binary.BigEndian.Uint16(size[:]))
				if _, err := io.ReadFull(conn, query); err != nil {
					return
				}
				out, err := Answer(query, pool)
				if err != nil {
					return
				}
				if _, err := conn.Write(append(binary.BigEndian.AppendUint16(nil, uint16(len(out))), out...)); err != nil {
					return
				}
			}
		}()
	}
}
