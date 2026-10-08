//go:build darwin

package nativewatch

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/shadowhusky/localdot/keyd/internal/privatestream"
)

const requestLimit = 256 * 1024

type launchRequest struct {
	V         int              `json:"v"`
	Command   string           `json:"command"`
	Args      []string         `json:"args"`
	Dir       string           `json:"dir"`
	Env       []string         `json:"env"`
	Resources *resourceRequest `json:"resources,omitempty"`
}

type notification struct {
	V      int    `json:"v"`
	Event  string `json:"event"`
	PID    int    `json:"pid,omitempty"`
	Code   *int   `json:"code,omitempty"`
	Signal *int   `json:"signal,omitempty"`
}

// Run is a private launcher protocol, not a model-facing shell API. The trusted daemon verifies
// the sandbox command and settings before sending one length-prefixed request on descriptor 3.
// That descriptor then becomes an empty parent-lifetime stream: EOF or any byte requests Stop.
// Descriptor 4 carries bounded lifecycle records, never task output. Neither is inherited by
// the task, and both must be anonymous local IPC. Stdio belongs directly to the sandbox child.
// Retirement requires a final record AND normal helper exit AND drainage of the actual pipes.
// A crash, timeout or lost record never authorizes resource removal.
func Run(args []string, control, events, stdin, stdout, stderr *os.File, leaseFD int) int {
	if len(args) != 0 || !supported() {
		return 2
	}
	streams := make([]*os.File, 0, 5)
	defer func() {
		for _, stream := range streams {
			_ = stream.Close()
		}
	}()
	for _, original := range []*os.File{control, events, stdin, stdout, stderr} {
		stream, err := privatestream.Duplicate(original)
		if err != nil {
			return 2
		}
		streams = append(streams, stream)
	}
	control, events = streams[0], streams[1]
	emit := func(record notification) bool {
		record.V = 1
		if events.SetWriteDeadline(time.Now().Add(time.Second)) != nil {
			return false
		}
		return json.NewEncoder(events).Encode(record) == nil
	}
	refuse := func() int { _ = emit(notification{Event: "refused"}); return 2 }
	if control.SetReadDeadline(time.Now().Add(5*time.Second)) != nil {
		return refuse()
	}
	var header [4]byte
	if _, err := io.ReadFull(control, header[:]); err != nil {
		return refuse()
	}
	size := binary.BigEndian.Uint32(header[:])
	if size == 0 || size > requestLimit {
		return refuse()
	}
	data := make([]byte, size)
	if _, err := io.ReadFull(control, data); err != nil || !utf8.Valid(data) {
		return refuse()
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var request launchRequest
	if decoder.Decode(&request) != nil || request.V != 1 || request.Args == nil || request.Env == nil {
		return refuse()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || control.SetReadDeadline(time.Time{}) != nil || !privatestream.OpenEmpty(control) {
		return refuse()
	}
	termination := make(chan os.Signal, 1)
	signal.Notify(termination, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	defer signal.Stop(termination)
	select {
	case <-termination:
		return refuse()
	default:
	}
	var ownership *resourceOwner
	if request.Resources != nil {
		var err error
		ownership, err = prepareResources(*request.Resources, leaseFD, request.Dir)
		if err != nil {
			return refuse()
		}
		defer ownership.close()
	}
	process, err := Start(Config{Command: request.Command, Args: request.Args, Dir: request.Dir, Env: request.Env,
		Stdin: streams[2], Stdout: streams[3], Stderr: streams[4]})
	if err != nil {
		if ownership != nil && ownership.publish() != nil {
			return 1
		}
		return refuse()
	}
	readDone := make(chan struct{})
	go func() {
		var one [1]byte
		_, _ = control.Read(one[:])
		process.Stop()
		close(readDone)
	}()
	// Failure to publish readiness also contains the child; never abandon a launched group.
	announced := emit(notification{Event: "started", PID: process.PID()})
	if !announced {
		process.Stop()
	}
	uncertain := process.Uncertain()
	for {
		select {
		case <-termination:
			process.Stop()
		case <-uncertain:
			uncertain = nil
			_ = emit(notification{Event: "uncertain"})
			// Keep observing and owning the unreaped leader even after the failure report.
		case result := <-process.Done():
			_ = control.Close()
			<-readDone
			if result.Err != nil {
				return 1
			}
			if ownership != nil && ownership.publish() != nil {
				return 1
			}
			if !announced {
				return 1
			}
			signal := int(result.Signal)
			if !emit(notification{Event: "retired", Code: &result.Code, Signal: &signal}) {
				return 1
			}
			return 0
		}
	}
}
