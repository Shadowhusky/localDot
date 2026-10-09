package gate

import (
	"bytes"
	"encoding/binary"
	"net"
	"strings"
)

// maxSniff bounds what the gate reads before it asks keyd: a ClientHello fits in one record.
const maxSniff = 16 << 10

var methods = []string{"GET ", "POST ", "PUT ", "HEAD ", "DELETE ", "OPTIONS ", "PATCH ", "CONNECT "}

// Named reads where a program's first bytes say they go: the server name of a TLS ClientHello or
// the Host of a plain HTTP request. more says the bytes so far are the start of one of those and
// could still name it.
func Named(start []byte) (name string, more bool) {
	if len(start) == 0 {
		return "", true
	}
	if start[0] == 0x16 {
		return helloName(start)
	}
	for _, m := range methods {
		if len(start) < len(m) {
			if strings.HasPrefix(m, string(start)) {
				return "", true
			}
			continue
		}
		if string(start[:len(m)]) == m {
			return hostHeader(start)
		}
	}
	return "", false
}

func hostHeader(start []byte) (string, bool) {
	end := bytes.Index(start, []byte("\r\n\r\n"))
	head := start
	if end >= 0 {
		head = start[:end]
	}
	lines := bytes.Split(head, []byte("\r\n"))
	// The last line may be cut short until the head is complete.
	complete := len(lines)
	if end < 0 {
		complete--
	}
	for _, line := range lines[1:max(complete, 1)] {
		key, value, ok := bytes.Cut(line, []byte(":"))
		if ok && strings.EqualFold(string(key), "host") {
			host := strings.TrimSpace(string(value))
			if h, _, err := net.SplitHostPort(host); err == nil {
				host = h
			}
			return host, false
		}
	}
	return "", end < 0
}

// helloName walks a ClientHello record to its server_name extension.
func helloName(start []byte) (string, bool) {
	if len(start) < 5 {
		return "", true
	}
	if start[1] != 3 {
		return "", false
	}
	size := int(binary.BigEndian.Uint16(start[3:5]))
	if len(start) < 5+size {
		return "", len(start) < maxSniff
	}
	b := start[5 : 5+size]
	// handshake type 1 and length, client version, random
	if len(b) < 4+2+32 || b[0] != 1 {
		return "", false
	}
	b = b[4+2+32:]
	skip := func(lenBytes int) bool {
		if len(b) < lenBytes {
			return false
		}
		n := 0
		for _, c := range b[:lenBytes] {
			n = n<<8 | int(c)
		}
		if len(b) < lenBytes+n {
			return false
		}
		b = b[lenBytes+n:]
		return true
	}
	if !skip(1) || !skip(2) || !skip(1) || len(b) < 2 {
		return "", false
	}
	exts := b[2:]
	if n := int(binary.BigEndian.Uint16(b)); n <= len(exts) {
		exts = exts[:n]
	}
	for len(exts) >= 4 {
		typ, n := binary.BigEndian.Uint16(exts), int(binary.BigEndian.Uint16(exts[2:]))
		if len(exts) < 4+n {
			return "", false
		}
		data := exts[4 : 4+n]
		exts = exts[4+n:]
		if typ != 0 || len(data) < 2 {
			continue
		}
		list := data[2:]
		for len(list) >= 3 {
			kind, l := list[0], int(binary.BigEndian.Uint16(list[1:3]))
			if len(list) < 3+l {
				return "", false
			}
			if kind == 0 {
				return string(list[3 : 3+l]), false
			}
			list = list[3+l:]
		}
	}
	return "", false
}
