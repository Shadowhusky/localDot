//go:build darwin

package nativewatch

import (
	"errors"
	"github.com/shadowhusky/localdot/keyd/internal/privatestream"
	"io"
	"os"
)

var ErrParent = errors.New("native supervisor parent channel is unavailable")

// Supervise observes an explicit, private parent-lifetime pipe independently of task stdin.
// EOF (including parent death) or any unexpected byte requests process-group retirement. A
// duplicated, non-inherited read descriptor is owned until both group and monitor are drained.
// Caller owns its original file and must not pass the writing end to any other process.
func Supervise(config Config, parent *os.File) (Result, error) {
	if !supported() {
		return Result{}, ErrUnsupported
	}
	pipe, err := privatestream.Duplicate(parent)
	if err != nil {
		return Result{}, ErrParent
	}
	defer pipe.Close()
	// A known-dead or already-invalid parent is refused before creating the task. EAGAIN is
	// the kernel's empty-pipe-with-a-writer result, not a timer or a remembered process identity.
	if !privatestream.OpenEmpty(pipe) {
		return Result{}, ErrParent
	}
	process, err := Start(config)
	if err != nil {
		return Result{}, err
	}
	read := make(chan error, 1)
	go func() {
		var byte [1]byte
		n, err := pipe.Read(byte[:])
		process.Stop()
		if n != 0 || (err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, os.ErrClosed)) {
			read <- ErrParent
		} else {
			read <- nil
		}
	}()
	result := <-process.Done()
	_ = pipe.Close()
	if readErr := <-read; readErr != nil {
		return result, readErr
	}
	return result, result.Err
}
