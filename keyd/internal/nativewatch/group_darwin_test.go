//go:build darwin && cgo

package nativewatch

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func TestChildFixture(t *testing.T) {
	mode := os.Getenv("LOCALDOT_NATIVEWATCH_FIXTURE")
	if mode == "" {
		return
	}
	switch mode {
	case "echo":
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			os.Exit(30)
		}
		_, _ = os.Stdout.Write(data)
		os.Exit(7)
	case "hold", "grandchild":
		signal.Ignore(syscall.SIGTERM)
		// Fixture-only failsafe: a broken supervisor must not leave a process behind. It emits
		// evidence before exit, so pipe/exit assertions cannot mistake this fallback for success.
		time.AfterFunc(10*time.Second, func() { fmt.Println("fixture-watchdog-fired"); os.Exit(90) })
		fmt.Printf("%s:%d\n", mode, os.Getpid())
		for {
			time.Sleep(time.Second)
		}
	case "fork-exit":
		child := exec.Command(os.Args[0], "-test.run=^TestChildFixture$")
		child.Env = []string{"LOCALDOT_NATIVEWATCH_FIXTURE=grandchild", "GORACE=atexit_sleep_ms=0"}
		child.Stdin, child.Stdout, child.Stderr = os.Stdin, os.Stdout, os.Stderr
		if child.Start() != nil {
			os.Exit(31)
		}
		// The child shares this leader's process group. Wait for the parent test to confirm that
		// the grandchild has installed its TERM handler before exiting this direct-child leader.
		var one [1]byte
		if _, err := os.Stdin.Read(one[:]); err != nil {
			os.Exit(32)
		}
		os.Exit(9)
	case "supervisor":
		parent := os.NewFile(3, "fixture-parent-lifetime")
		result, err := Supervise(Config{Command: os.Args[0], Args: []string{"-test.run=^TestChildFixture$"},
			Dir: os.Getenv("LOCALDOT_NATIVEWATCH_DIRECTORY"), Env: []string{"LOCALDOT_NATIVEWATCH_FIXTURE=hold", "GORACE=atexit_sleep_ms=0"},
			Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr}, parent)
		_ = parent.Close()
		if err != nil || result.Err != nil || result.Signal != syscall.SIGKILL {
			os.Exit(34)
		}
		fmt.Println("supervisor:retired")
		os.Exit(0)
	case "parent":
		time.AfterFunc(12*time.Second, func() { fmt.Println("fixture-parent-watchdog-fired"); os.Exit(90) })
		read, write, err := os.Pipe()
		if err != nil {
			os.Exit(35)
		}
		guard := exec.Command(os.Args[0], "-test.run=^TestChildFixture$")
		guard.Env = []string{"LOCALDOT_NATIVEWATCH_FIXTURE=supervisor", "LOCALDOT_NATIVEWATCH_DIRECTORY=" + os.Getenv("LOCALDOT_NATIVEWATCH_DIRECTORY"), "GORACE=atexit_sleep_ms=0"}
		guard.Stdin, guard.Stdout, guard.Stderr = os.Stdin, os.Stdout, os.Stderr
		guard.ExtraFiles = []*os.File{read}
		if guard.Start() != nil {
			os.Exit(36)
		}
		_ = read.Close()
		fmt.Printf("supervisor:%d\n", guard.Process.Pid)
		// Only this process has the writer. SIGKILL must close it without any Go cleanup running.
		defer write.Close()
		for {
			time.Sleep(time.Second)
		}
	}
	os.Exit(33)
}

type fixture struct {
	p             *Process
	input, output *os.File
	lines         *bufio.Reader
}

func launchFixture(t *testing.T, mode string, observe observer) fixture {
	t.Helper()
	inR, inW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	config := Config{Command: os.Args[0], Args: []string{"-test.run=^TestChildFixture$"}, Dir: t.TempDir(),
		Env: []string{"LOCALDOT_NATIVEWATCH_FIXTURE=" + mode, "GORACE=atexit_sleep_ms=0"}, Stdin: inR, Stdout: outW, Stderr: outW}
	p, err := start(config, observe)
	_ = inR.Close()
	_ = outW.Close()
	if err != nil {
		_ = inW.Close()
		_ = outR.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		p.Stop()
		select {
		case <-p.Done():
		case <-time.After(5 * time.Second):
			t.Error("owned process did not retire")
		}
		_ = inW.Close()
		_ = outR.Close()
	})
	_ = outR.SetReadDeadline(time.Now().Add(5 * time.Second))
	return fixture{p: p, input: inW, output: outR, lines: bufio.NewReader(outR)}
}

func awaitResult(t *testing.T, p *Process) Result {
	t.Helper()
	select {
	case result, ok := <-p.Done():
		if !ok {
			t.Fatal("missing retirement result")
		}
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("retirement timeout")
	}
	return Result{}
}

func TestPipesAndNaturalExit(t *testing.T) {
	f := launchFixture(t, "echo", observeGroup)
	_, _ = io.WriteString(f.input, "private fixture message\n")
	_ = f.input.Close()
	line, err := f.lines.ReadString('\n')
	if err != nil || line != "private fixture message\n" {
		t.Fatalf("pipe mismatch: %v", err)
	}
	r := awaitResult(t, f.p)
	if r.Err != nil || r.Code != 7 || r.Signal != 0 {
		t.Fatalf("wrong exit: %+v", r)
	}
	select {
	case <-f.p.Uncertain():
		t.Fatal("normal exit marked uncertain")
	default:
	}
	// The owner reaped exactly once, after the observation barrier.
	var status syscall.WaitStatus
	if _, err := syscall.Wait4(f.p.PID(), &status, syscall.WNOHANG, nil); !errors.Is(err, syscall.ECHILD) {
		t.Fatalf("leader was not reaped: %v", err)
	}
}

func TestStopKillsAnIgnoringLeaderAfterGrace(t *testing.T) {
	f := launchFixture(t, "hold", observeGroup)
	line, err := f.lines.ReadString('\n')
	if err != nil || line != fmt.Sprintf("hold:%d\n", f.p.PID()) {
		t.Fatal("leader did not become ready")
	}
	f.p.Stop()
	f.p.Stop()
	r := awaitResult(t, f.p)
	if r.Err != nil || r.Signal != syscall.SIGKILL {
		t.Fatalf("TERM-ignoring leader was not killed: %+v", r)
	}
	if _, err := f.lines.ReadByte(); err != io.EOF {
		t.Fatalf("child pipe still live: %v", err)
	}
}

func TestRetainsExitedLeaderUntilIgnoringGrandchildRetires(t *testing.T) {
	var leaderExited atomic.Bool
	observe := func(pid int) (groupState, error) {
		state, err := observeGroup(pid)
		if err == nil && state.exited && !state.quiet {
			leaderExited.Store(true)
		}
		return state, err
	}
	f := launchFixture(t, "fork-exit", observe)
	line, err := f.lines.ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "grandchild:") {
		t.Fatal("grandchild did not become ready")
	}
	grandchild, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "grandchild:")))
	if err != nil || grandchild <= 1 || grandchild == f.p.PID() {
		t.Fatal("invalid grandchild")
	}
	_, _ = f.input.Write([]byte{1})
	r := awaitResult(t, f.p)
	if r.Err != nil || r.Code != 9 || !leaderExited.Load() {
		t.Fatalf("leader was not reserved through descendant shutdown: %+v", r)
	}
	if _, err := f.lines.ReadByte(); err != io.EOF {
		t.Fatalf("grandchild still owns pipe: %v", err)
	}
}

func TestUncertainObservationDoesNotPublishRetirement(t *testing.T) {
	var refuse atomic.Bool
	refuse.Store(true)
	observe := func(pid int) (groupState, error) {
		if refuse.Load() {
			return groupState{}, ErrObservation
		}
		return observeGroup(pid)
	}
	f := launchFixture(t, "hold", observe)
	t.Cleanup(func() { refuse.Store(false) })
	select {
	case <-f.p.Uncertain():
	case <-time.After(time.Second):
		t.Fatal("failure was not reported")
	}
	select {
	case <-f.p.Done():
		t.Fatal("uncertainty incorrectly proved retirement")
	default:
	}
	refuse.Store(false)
	r := awaitResult(t, f.p)
	if !errors.Is(r.Err, ErrObservation) {
		t.Fatalf("observation failure was lost: %+v", r)
	}
}

func TestRefusesInvalidLaunchAndRedactsExecErrors(t *testing.T) {
	base := Config{Command: "/nonexistent-nativewatch-private-path", Dir: t.TempDir(), Env: []string{}}
	for _, change := range []func(*Config){
		func(c *Config) { c.Command = "relative" },
		func(c *Config) { c.Dir = "relative" },
		func(c *Config) { c.Env = nil },
		func(c *Config) { c.Args = []string{"bad\x00argument"} },
		func(c *Config) { c.Args = make([]string, 1025) },
		func(c *Config) { c.Env = []string{strings.Repeat("x", 256*1024+1)} },
		func(c *Config) {},
	} {
		c := base
		change(&c)
		p, err := Start(c)
		if p != nil || !errors.Is(err, ErrStart) || strings.Contains(err.Error(), "private-path") {
			t.Fatalf("unsafe failure: %v", err)
		}
	}
}

func TestSupervisorRetiresTaskAfterActualParentSIGKILL(t *testing.T) {
	parent := exec.Command(os.Args[0], "-test.run=^TestChildFixture$")
	parent.Env = []string{"LOCALDOT_NATIVEWATCH_FIXTURE=parent", "LOCALDOT_NATIVEWATCH_DIRECTORY=" + t.TempDir(), "GORACE=atexit_sleep_ms=0"}
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	parent.Stdout, parent.Stderr = write, write
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	_ = write.Close()
	t.Cleanup(func() { _ = parent.Process.Kill(); _ = read.Close() })
	_ = read.SetReadDeadline(time.Now().Add(8 * time.Second))
	lines := bufio.NewReader(read)
	seenSupervisor, seenTask := false, false
	for i := 0; i < 2; i++ {
		line, err := lines.ReadString('\n')
		if err != nil {
			t.Fatalf("fixture startup failed: %v", err)
		}
		if strings.HasPrefix(line, "supervisor:") {
			seenSupervisor = true
		}
		if strings.HasPrefix(line, "hold:") {
			seenTask = true
		}
	}
	if !seenSupervisor || !seenTask {
		t.Fatal("supervisor and task were not ready")
	}
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := parent.Wait(); err == nil {
		t.Fatal("parent did not die by signal")
	}
	line, err := lines.ReadString('\n')
	if err != nil || line != "supervisor:retired\n" {
		t.Fatalf("no confirmed retirement: %q %v", line, err)
	}
	if _, err := lines.ReadByte(); err != io.EOF {
		t.Fatalf("descendant-held pipe remains: %v", err)
	}
}

func TestSupervisorRefusesAlreadyDeadOrInvalidParentBeforeLaunch(t *testing.T) {
	config := Config{Command: "/nonexistent-launch-must-not-run", Dir: t.TempDir(), Env: []string{}}
	for _, invalid := range []bool{false, true} {
		read, write, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		if invalid {
			_, _ = write.Write([]byte{1})
		}
		_ = write.Close()
		_, err = Supervise(config, read)
		_ = read.Close()
		if !errors.Is(err, ErrParent) {
			t.Fatalf("parent rejection was bypassed: %v", err)
		}
	}
	file, err := os.Open(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := Supervise(config, file); !errors.Is(err, ErrParent) {
		t.Fatal("regular file accepted as lifetime pipe")
	}
}

func TestSupervisorDrainsMonitorWhenTaskExitsBeforeParent(t *testing.T) {
	read, write, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer read.Close()
	defer write.Close()
	result, err := Supervise(Config{Command: os.Args[0], Args: []string{"-test.run=^TestChildFixture$"}, Dir: t.TempDir(),
		Env: []string{"LOCALDOT_NATIVEWATCH_FIXTURE=echo", "GORACE=atexit_sleep_ms=0"}}, read)
	if err != nil || result.Code != 7 || result.Err != nil {
		t.Fatalf("normal child exit did not drain monitor: %+v %v", result, err)
	}
}

func TestSupervisorActualNodeControlStream(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("Node is required for transport acceptance")
	}
	const script = `
import {spawn} from 'node:child_process';
const [binary,directory]=process.argv.slice(1);
const child=spawn(binary,['-test.run=^TestChildFixture$'],{cwd:directory,
 env:{LOCALDOT_NATIVEWATCH_FIXTURE:'supervisor',LOCALDOT_NATIVEWATCH_DIRECTORY:directory,GORACE:'atexit_sleep_ms=0'},
 stdio:['ignore','pipe','pipe','pipe']});
let output='',error='',stopped=false;
const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
child.stdout.on('data',b=>{output+=b;if(output.length>4096)child.kill('SIGKILL');if(!stopped&&/^hold:[0-9]+\n/.test(output)){stopped=true;child.stdio[3].end()}});
child.stderr.on('data',b=>{error+=b;if(error.length>4096)child.kill('SIGKILL')});
const [code,signal]=await new Promise(resolve=>child.once('close',(...args)=>resolve(args)));
clearTimeout(timer);
if(code!==0||signal||error||!/^hold:[0-9]+\nsupervisor:retired\n$/.test(output))process.exitCode=1;
else console.log('node-control-retired');
`
	command := exec.Command(node, "--input-type=module", "-e", script, os.Args[0], t.TempDir())
	command.Env = []string{"PATH=" + os.Getenv("PATH")}
	output, err := command.CombinedOutput()
	if err != nil || string(output) != "node-control-retired\n" {
		t.Fatalf("Node supervisor stream failed: %v; bytes=%d", err, len(output))
	}
}
