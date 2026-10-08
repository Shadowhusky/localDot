package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"os/signal"
	"regexp"
	"syscall"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/canaryrun"
	"github.com/shadowhusky/localdot/keyd/internal/privatestream"
)

// Keep the adopted descriptor reachable until os.Exit, beyond audit closure/receipt emission.
var canaryLifetimeLease *os.File

// canary-run is a separate bounded child, never the installed keyd service. Parent keeps stdin
// open while its journal-owned Docker cell is scanned, closes it to retire the gateway, and
// waits for actual process exit before collecting final artifacts. Only private pipes carry ready.
func runCanary(args []string, input, output *os.File) int {
	canaryLifetimeLease = os.NewFile(3, "canary-directory")
	return runCanaryWith(args, input, output, os.Stderr, canaryLifetimeLease, func(ctx context.Context, config canaryrun.Config) (canarySession, error) {
		return canaryrun.Start(ctx, config)
	})
}

type canarySession interface {
	Ready() canaryrun.Ready
	Close() (canaryrun.Closed, error)
}

func runCanaryWith(args []string, input, output, errorOutput, lease *os.File, start func(context.Context, canaryrun.Config) (canarySession, error)) int {
	flags := flag.NewFlagSet("canary-run", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	directory := flags.String("directory", "", "owned empty diagnostic directory")
	cell := flags.String("cell", "", "owned diagnostic cell id")
	run := flags.String("run", "", "diagnostic operation UUID")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return 2
	}
	// Node/libuv supplies anonymous Unix socketpairs for child streams. Require anonymous IPC,
	// then adopt poller-backed duplicates so deadlines and cancellation drain real inherited fds.
	// Never put the synthetic credential receipt in a redirected file or a network/named socket.
	streams := make([]*os.File, 0, 3)
	for _, file := range []*os.File{input, output, errorOutput} {
		stream, err := privatestream.Duplicate(file)
		if err != nil {
			return 2
		}
		defer stream.Close()
		streams = append(streams, stream)
	}
	input, output, errorOutput = streams[0], streams[1], streams[2]
	if input.SetReadDeadline(time.Now().Add(10*time.Minute)) != nil || output.SetWriteDeadline(time.Now().Add(10*time.Second)) != nil {
		return 2
	}
	if canaryrun.AdoptDirectoryLease(*directory, lease) != nil {
		return 73
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	finishRead := context.AfterFunc(ctx, func() { _ = input.Close() })
	defer finishRead()
	session, err := start(ctx, canaryrun.Config{Directory: *directory, CellID: *cell, RunID: *run})
	if err != nil {
		return 1
	}
	defer session.Close()
	marker := func(phase string) error {
		if err := errorOutput.SetWriteDeadline(time.Now().Add(10 * time.Second)); err != nil {
			return err
		}
		_, err := io.WriteString(errorOutput, "canary:"+*run+":"+phase+"\n")
		return err
	}
	// Fixed non-secret continuity markers prove stderr was captured from startup
	// through gateway/audit closure. The parent still waits for actual process exit.
	if marker("ready") != nil {
		return 1
	}
	if json.NewEncoder(output).Encode(session.Ready()) != nil {
		return 1
	}
	var data [1]byte
	n, readErr := input.Read(data[:])
	closed, closeErr := session.Close()
	if marker("closed") != nil {
		return 1
	}
	if output.SetWriteDeadline(time.Now().Add(10*time.Second)) != nil || json.NewEncoder(output).Encode(closed) != nil {
		return 1
	}
	if n != 0 || readErr != io.EOF || ctx.Err() != nil || closeErr != nil {
		return 1
	}
	return 0
}

// A verified helper can acquire the same directory lease for interrupted-run recovery. The
// parent retains its descriptor after this helper exits, exactly as with install-lock.
func runCanaryLock(args []string, lease, output *os.File) int {
	if len(args) != 2 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(args[1]) {
		return 2
	}
	if canaryrun.AdoptDirectoryLease(args[0], lease) != nil {
		return 73
	}
	if _, err := io.WriteString(output, "locked:"+args[1]+"\n"); err != nil {
		return 1
	}
	return 0
}
