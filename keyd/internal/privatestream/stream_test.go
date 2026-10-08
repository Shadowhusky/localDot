//go:build darwin || linux

package privatestream

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func socketPair(t *testing.T, kind int) (*os.File, *os.File) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, kind, 0)
	if err != nil {
		t.Fatal(err)
	}
	a, b := os.NewFile(uintptr(fds[0]), "a"), os.NewFile(uintptr(fds[1]), "b")
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return a, b
}

func TestAnonymousStreamsRemainInterruptible(t *testing.T) {
	for _, kind := range []string{"pipe", "socketpair"} {
		t.Run(kind, func(t *testing.T) {
			var a, b *os.File
			if kind == "socketpair" {
				a, b = socketPair(t, syscall.SOCK_STREAM)
			} else {
				var err error
				a, b, err = os.Pipe()
				if err != nil {
					t.Fatal(err)
				}
				defer a.Close()
				defer b.Close()
			}
			copy, err := Duplicate(a)
			if err != nil {
				t.Fatal(err)
			}
			defer copy.Close()
			if !OpenEmpty(copy) {
				t.Fatal("open empty stream was rejected")
			}
			_, _ = b.Write([]byte("x"))
			var data [1]byte
			if n, err := copy.Read(data[:]); n != 1 || err != nil || data[0] != 'x' {
				t.Fatal("stream bytes lost")
			}
			completed := make(chan error, 1)
			go func() { _, err := copy.Read(data[:]); completed <- err }()
			_ = copy.Close()
			select {
			case err := <-completed:
				if err == nil {
					t.Fatal("closed read succeeded")
				}
			case <-time.After(time.Second):
				t.Fatal("close failed to interrupt read")
			}
		})
	}
}

func TestNoWriterOrUnexpectedInputIsNotAnOpenEmptyStream(t *testing.T) {
	for _, data := range []string{"", "x"} {
		a, b := socketPair(t, syscall.SOCK_STREAM)
		copy, err := Duplicate(a)
		if err != nil {
			t.Fatal(err)
		}
		defer copy.Close()
		_, _ = io.WriteString(b, data)
		_ = b.Close()
		if OpenEmpty(copy) {
			t.Fatal("closed/invalid lifetime stream accepted")
		}
	}
}

func TestRejectsNonPrivateStreams(t *testing.T) {
	file, err := os.Create(filepath.Join(t.TempDir(), "file"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	dgram, _ := socketPair(t, syscall.SOCK_DGRAM)
	inetFD, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	inet := os.NewFile(uintptr(inetFD), "inet")
	defer inet.Close()
	namedPath := filepath.Join(t.TempDir(), "fifo")
	if err := syscall.Mkfifo(namedPath, 0600); err != nil {
		t.Fatal(err)
	}
	named, err := os.OpenFile(namedPath, os.O_RDWR|syscall.O_NONBLOCK, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer named.Close()
	unconnectedFD, err := syscall.Socket(syscall.AF_UNIX, syscall.SOCK_STREAM, 0)
	if err != nil {
		t.Fatal(err)
	}
	unconnected := os.NewFile(uintptr(unconnectedFD), "unconnected")
	defer unconnected.Close()
	for _, candidate := range []*os.File{nil, file, dgram, inet, named, unconnected} {
		if stream, err := Duplicate(candidate); err == nil || stream != nil {
			t.Fatal("unsafe stream accepted")
		}
	}
	info, _ := file.Stat()
	if info.Size() != 0 {
		t.Fatal("file data was written")
	}
}

// A connection to a socket bound in the filesystem is reachable by name, so either end of it is
// refused even though it is a connected Unix stream.
func TestRejectsBothEndsOfANamedSocket(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "privatestream-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(dir, "s"), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialUnix("unix", nil, listener.Addr().(*net.UnixAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	for name, conn := range map[string]*net.UnixConn{"dialing end": client, "accepted end": server} {
		file, err := conn.File()
		if err != nil {
			t.Fatal(err)
		}
		if stream, err := Duplicate(file); err == nil || stream != nil {
			t.Errorf("the %s of a named socket was accepted", name)
		}
		file.Close()
	}
}
