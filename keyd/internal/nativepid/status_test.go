package nativepid

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
)

func TestState(t *testing.T) {
	if state(nil, 10, "old") != "exited" {
		t.Fatal("absent group")
	}
	if state([]member{{pid: 10, start: "new", live: true}}, 10, "old") != "unknown" {
		t.Fatal("reused leader")
	}
	if state([]member{{pid: 10, start: "old"}, {pid: 11, start: "child", live: true}}, 10, "old") != "alive" {
		t.Fatal("live descendant")
	}
	if state([]member{{pid: 10, start: "old"}}, 10, "old") != "exited" {
		t.Fatal("zombie")
	}
}
func TestOwnedGroup(t *testing.T) {
	child := exec.Command("/bin/sleep", "30")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	rows, err := group(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].parent != os.Getpid() || rows[0].uid != os.Getuid() || !rows[0].live || rows[0].start == "" {
		t.Fatal("missing live owned leader")
	}
	start := rows[0].start
	if state(rows, child.Process.Pid, start) != "alive" {
		t.Fatal("live leader")
	}
	_ = child.Process.Kill()
	_ = child.Wait()
	rows, err = group(child.Process.Pid)
	if err != nil || state(rows, child.Process.Pid, start) != "exited" {
		t.Fatal("exited group", err)
	}
}
