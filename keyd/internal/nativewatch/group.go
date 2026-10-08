// Package nativewatch owns a direct process-group leader until its group is quiescent.
// It never signals a PID recovered from persistent storage.
package nativewatch

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

var ErrUnsupported = errors.New("native process supervision is unavailable")
var ErrStart = errors.New("native process could not be started")
var ErrObservation = errors.New("native process retirement could not be confirmed")

// Config is a trusted launcher's input, not a model-facing command API. The caller must verify
// the sandbox executable, arguments, profile, environment and working directory before Start.
// Only explicit files are inherited; no extra control/lease descriptor is passed to the task.
type Config struct {
	Command               string
	Args                  []string
	Dir                   string
	Env                   []string
	Stdin, Stdout, Stderr *os.File
}

type Result struct {
	Code   int
	Signal syscall.Signal
	Err    error
}

// Process retains the unreaped leader internally. Done resolves only after a kernel observation
// of group quiescence and reaping the direct child. Uncertain is a failure notification, never a
// retirement signal: the observer and PID reservation remain owned until Done.
type Process struct {
	pid       int
	stop      chan struct{}
	done      chan Result
	uncertain chan struct{}
	once      sync.Once
}

func (p *Process) PID() int                   { return p.pid }
func (p *Process) Done() <-chan Result        { return p.done }
func (p *Process) Uncertain() <-chan struct{} { return p.uncertain }
func (p *Process) Stop()                      { p.once.Do(func() { close(p.stop) }) }

type groupState struct{ exited, quiet bool }
type observer func(int) (groupState, error)

func Start(config Config) (*Process, error) { return start(config, observeGroup) }

func start(config Config, observe observer) (*Process, error) {
	if !supported() {
		return nil, ErrUnsupported
	}
	if !filepath.IsAbs(config.Command) || filepath.Clean(config.Command) != config.Command ||
		!filepath.IsAbs(config.Dir) || filepath.Clean(config.Dir) != config.Dir || config.Env == nil ||
		len(config.Args) > 1024 || len(config.Env) > 1024 {
		return nil, ErrStart
	}
	args, env := append([]string{}, config.Args...), append([]string{}, config.Env...)
	total := len(config.Command) + len(config.Dir)
	for _, s := range append(append([]string{config.Command, config.Dir}, args...), env...) {
		if strings.ContainsRune(s, 0) {
			return nil, ErrStart
		}
		total += len(s)
		if total > 256*1024 {
			return nil, ErrStart
		}
	}
	cmd := exec.Command(config.Command, args...)
	cmd.Dir, cmd.Env = config.Dir, env
	// Use files directly: exec does not own asynchronous copying goroutines whose completion could
	// hide descendant-held pipes. The supervisor protocol must separately drain its parent pipes.
	cmd.Stdin, cmd.Stdout, cmd.Stderr = config.Stdin, config.Stdout, config.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if cmd.Start() != nil {
		return nil, ErrStart
	}
	p := &Process{pid: cmd.Process.Pid, stop: make(chan struct{}), done: make(chan Result, 1), uncertain: make(chan struct{})}
	go p.own(cmd, observe)
	return p, nil
}

func (p *Process) own(cmd *exec.Cmd, observe observer) {
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	var failure error
	flag := func() {
		if failure == nil {
			failure = ErrObservation
			close(p.uncertain)
		}
	}
	var stopping time.Time
	killed := false
	request := p.stop
	signal := func(sig syscall.Signal, observedQuiet bool) {
		// This direct child has never been reaped: its PID cannot be recycled for another group.
		// Darwin returns EPERM for an all-zombie group. Accept that only after the kernel
		// observer found an exited leader and no live members; the next observation must
		// still confirm quiescence before reaping. EPERM on a live group remains a failure.
		if err := syscall.Kill(-p.pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) &&
			!(observedQuiet && errors.Is(err, syscall.EPERM)) {
			flag()
		}
	}
	beginStop := func() {
		if stopping.IsZero() {
			stopping = time.Now()
			signal(syscall.SIGTERM, false)
		}
	}
	for {
		state, err := observe(p.pid)
		if err != nil {
			flag()
			beginStop()
		} else if state.exited && !killed {
			// Sweep any descendants while the exited leader still reserves this group. Observe
			// again after SIGKILL before accepting quiescence; never reap at the first snapshot.
			killed = true
			signal(syscall.SIGKILL, state.quiet)
		} else if state.exited && state.quiet {
			// No other path in this owner calls Wait. WNOWAIT kept the direct child reserved until
			// every group member observed by the kernel had completed execution.
			waitErr := cmd.Wait()
			var exitError *exec.ExitError
			if waitErr != nil && !errors.As(waitErr, &exitError) {
				flag()
			}
			result := Result{Code: -1, Err: failure}
			if cmd.ProcessState != nil {
				result.Code = cmd.ProcessState.ExitCode()
				if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok && status.Signaled() {
					result.Signal = status.Signal()
				}
			}
			p.done <- result
			close(p.done)
			return
		} else if state.exited {
			beginStop()
		}
		if !stopping.IsZero() && !killed && time.Since(stopping) >= time.Second {
			killed = true
			signal(syscall.SIGKILL, false)
		}
		select {
		case <-request:
			request = nil
			beginStop()
		case <-ticker.C:
		}
	}
}
