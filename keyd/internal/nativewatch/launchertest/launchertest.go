// Package launchertest drives the native-run protocol from tests, as the daemon does: one
// length-prefixed request on descriptor 3, lifecycle records on descriptor 4, private pipes for
// stdio.
package launchertest

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"testing"
	"time"
)

type Event struct {
	Event string `json:"event"`
	Code  *int   `json:"code"`
}

// Run starts cmd as a launcher asked to run command with args, waits for it to exit and returns
// the records it wrote and its exit status.
func Run(t testing.TB, cmd *exec.Cmd, command string, args []string) ([]Event, int) {
	t.Helper()
	var parent, child []*os.File
	pipe := func() (*os.File, *os.File) {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		return r, w
	}
	controlR, controlW := pipe()
	eventsR, eventsW := pipe()
	inR, inW := pipe()
	outR, outW := pipe()
	errR, errW := pipe()
	parent = append(parent, controlW, eventsR, inW, outR, errR)
	child = append(child, controlR, eventsW, inR, outW, errW)
	defer func() {
		for _, f := range parent {
			f.Close()
		}
	}()
	cmd.ExtraFiles = []*os.File{controlR, eventsW}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	err := cmd.Start()
	for _, f := range child {
		f.Close()
	}
	if err != nil {
		t.Fatal(err)
	}
	go io.Copy(io.Discard, outR)
	go io.Copy(io.Discard, errR)
	request, err := json.Marshal(map[string]any{"v": 1, "command": command, "args": args, "dir": "/", "env": []string{}})
	if err != nil {
		t.Fatal(err)
	}
	// A launcher that refuses may exit before reading; its closed pipe is not this helper's failure.
	_, _ = controlW.Write(append(binary.BigEndian.AppendUint32(nil, uint32(len(request))), request...))
	records := make(chan []Event, 1)
	go func() {
		var events []Event
		scanner := bufio.NewScanner(eventsR)
		for scanner.Scan() {
			var event Event
			if json.Unmarshal(scanner.Bytes(), &event) == nil {
				events = append(events, event)
			}
		}
		records <- events
	}()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		cmd.Process.Kill()
		<-done
		t.Fatal("the launcher did not exit")
	}
	return <-records, cmd.ProcessState.ExitCode()
}
