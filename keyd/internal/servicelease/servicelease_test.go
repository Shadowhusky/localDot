package servicelease

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/admin"
	"github.com/shadowhusky/localdot/keyd/internal/installlock"
)

func TestMain(m *testing.M) {
	if os.Getenv("LOCALDOT_SERVICE_EXEC_FIXTURE") == "1" {
		os.Exit(RunExec(os.Args[1:], os.Stderr))
	}
	os.Exit(m.Run())
}

func TestConfigurationDigestMatchesJavaScript(t *testing.T) {
	// Fixed vectors generated with Node's JSON.stringify, including real Unicode separators
	// and literal escaped spellings. Go's JSON encoder escapes the former by default.
	for _, v := range []struct{ home, want string }{
		{"/Users/a<&>/dot", "94dfbba8d4f23efb2cb04194c0f317f7449b402323d0918967feda26e0271b0f"},
		{"/Users/a\u2028b\u2029c/\\u2028\\u2029/dot", "3a581c6760b827de48763e73bcefd43c853266d29fb12daa0b681c934c6d1ba2"},
	} {
		c := configuration{Settings: settings{Home: v.home, UserHome: "/Users/example", Node: "/usr/bin/node", DockerSocket: "/tmp/docker.sock", UID: 501, Port: 4750}, Release: admin.ReleaseIdentity{Version: "1.2.3", PackageSHA256: strings.Repeat("b", 64), ManifestSHA256: strings.Repeat("c", 64)}}
		if got := configurationID(c); got != v.want {
			t.Fatalf("configuration digest %s, want %s", got, v.want)
		}
	}
}

type fixture struct {
	scope  Scope
	record journal
	helper string
}

func makeFixture(t *testing.T, role string) *fixture {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	state, home := filepath.Join(root, "state"), filepath.Join(root, "home")
	for _, dir := range []string{state, home, filepath.Join(state, "tmp")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	owner := strings.Repeat("a", 32)
	s := settings{state, home, "/Users/example", "/usr/bin/true", filepath.Join(root, "docker.sock"), os.Getuid(), 4750, owner}
	c := configuration{Settings: s, Release: admin.ReleaseIdentity{Version: "1.2.3", PackageSHA256: strings.Repeat("b", 64), ManifestSHA256: strings.Repeat("c", 64)}}
	c.Configuration = configurationID(c)
	record := journal{V: 1, ID: "01234567-89ab-4cde-8fab-0123456789ab", Configuration: c, Previous: json.RawMessage("null"), Phase: "starting"}
	record.Jobs.Keyd = job{Phase: "starting"}
	record.Jobs.Daemon = job{Phase: "absent"}
	if role == "daemon" {
		pid := 41
		record.Jobs.Keyd = job{"running", &pid}
		record.Jobs.Daemon = job{Phase: "starting"}
	}
	helper := filepath.Join(state, "releases", c.Release.PackageSHA256+"-"+c.Release.ManifestSHA256, "keyd", "bin", "keyd")
	if err := os.MkdirAll(filepath.Dir(helper), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(helper, []byte("fake helper"), 0o700); err != nil {
		t.Fatal(err)
	}
	f := &fixture{Scope{state, home, owner, c.Configuration, role}, record, helper}
	f.save(t)
	body, _ := json.Marshal(ownerRecord{1, owner, state, home, os.Getuid()})
	if err := os.WriteFile(filepath.Join(state, "service-owner.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
	return f
}
func (f *fixture) save(t *testing.T) {
	t.Helper()
	data, _ := json.Marshal(f.record)
	if err := os.WriteFile(filepath.Join(f.scope.State, "service-journal.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}
func pins(string) string { return "ghcr.io/example/image@sha256:" + strings.Repeat("d", 64) }
func (f *fixture) prepare(t *testing.T) *Launch {
	t.Helper()
	l, e := Prepare(f.scope, f.helper, pins)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { l.Lease.Close() })
	return l
}

func TestRoleLeaseAndDerivedLaunch(t *testing.T) {
	for _, role := range []string{"keyd", "daemon"} {
		t.Run(role, func(t *testing.T) {
			f := makeFixture(t, role)
			l := f.prepare(t)
			if other, err := installlock.AcquireService(f.scope.State, f.scope.Owner, role); !errors.Is(err, installlock.ErrBusy) {
				if other != nil {
					other.Close()
				}
				t.Fatalf("not exclusive: %v", err)
			}
			if _, err := Prepare(f.scope, f.helper, pins); !errors.Is(err, installlock.ErrBusy) {
				t.Fatal("second process admitted")
			}
			if strings.Contains(strings.Join(l.Environment, "\n"), "NODE_OPTIONS") {
				t.Fatal("loader environment inherited")
			}
			if role == "keyd" && (l.Program != f.helper || strings.Join(l.Arguments[1:], " ") != "-home "+f.scope.Home+" -vault "+vaultMode(runtime.GOOS)+" -ports 4760-4789") {
				t.Fatal("keyd defaults changed")
			}
			if role == "daemon" && (l.Program != "/usr/bin/true" || !strings.HasSuffix(l.Arguments[1], "/app/dist/daemon.mjs")) {
				t.Fatal("wrong daemon entry")
			}
			if !strings.Contains(strings.Join(l.Environment, "\n"), "LOCALDOT_SERVICE_ATTEMPT="+f.record.ID) {
				t.Fatal("missing attempt binding")
			}
			called := false
			if err := l.Exec(func(program string, args, env []string) error {
				called = true
				return errors.New("fixture exec failure")
			}); err == nil || !called {
				t.Fatal("exec failure lost")
			}
			l.Lease.Close()
			next, err := installlock.AcquireService(f.scope.State, f.scope.Owner, role)
			if err != nil {
				t.Fatal(err)
			}
			next.Close()
		})
	}
}
func TestLateOrCorruptLaunchRefused(t *testing.T) {
	for _, kind := range []string{"stopping", "stopped", "running", "validating", "job", "owner", "configuration", "settings", "helper", "image", "journal-mode", "journal-link", "journal-too-large"} {
		t.Run(kind, func(t *testing.T) {
			f := makeFixture(t, "daemon")
			lookup := pins
			path := f.helper
			switch kind {
			case "stopping", "stopped", "running", "validating":
				f.record.Phase = kind
			case "job":
				f.record.Jobs.Daemon.Phase = "loaded"
			case "owner":
				f.scope.Owner = strings.Repeat("e", 32)
			case "configuration":
				f.scope.Configuration = strings.Repeat("e", 64)
			case "settings":
				f.record.Configuration.Settings.Node = "/usr/bin/false"
			case "helper":
				path = "/usr/bin/true"
			case "image":
				lookup = func(string) string { return "image:latest" }
			}
			f.save(t)
			journalPath := filepath.Join(f.scope.State, "service-journal.json")
			if kind == "journal-mode" {
				os.Chmod(journalPath, 0o644)
			}
			if kind == "journal-link" {
				os.Rename(journalPath, journalPath+".real")
				os.Symlink(journalPath+".real", journalPath)
			}
			if kind == "journal-too-large" {
				os.WriteFile(journalPath, bytes.Repeat([]byte("x"), 16385), 0o600)
			}
			if l, e := Prepare(f.scope, path, lookup); e == nil {
				l.Lease.Close()
				t.Fatal("unsafe launch accepted")
			}
		})
	}
}
func TestStopOrAttemptChangeBetweenPrepareAndExec(t *testing.T) {
	for _, kind := range []string{"stop", "attempt"} {
		t.Run(kind, func(t *testing.T) {
			f := makeFixture(t, "daemon")
			l := f.prepare(t)
			if kind == "stop" {
				f.record.Phase = "stopping"
			} else {
				f.record.ID = "11234567-89ab-4cde-8fab-0123456789ab"
			}
			f.save(t)
			if err := l.Exec(func(string, []string, []string) error { t.Fatal("late exec admitted"); return nil }); err == nil {
				t.Fatal("late exec accepted")
			}
		})
	}
}

func TestKickstartObservationCanPrecedeExec(t *testing.T) {
	for _, phase := range []string{"starting", "validating"} {
		t.Run(phase, func(t *testing.T) {
			f := makeFixture(t, "daemon")
			l := f.prepare(t)
			pid := os.Getpid()
			f.record.Jobs.Daemon = job{"running", &pid}
			f.record.Phase = phase
			f.save(t)
			called := false
			if err := l.Exec(func(string, []string, []string) error { called = true; return errors.New("fixture exec") }); err == nil || !called {
				t.Fatal("valid PID observation blocked exec")
			}
			l.Lease.Close()
			second, err := Prepare(f.scope, f.helper, pins)
			if err != nil {
				t.Fatal(err)
			}
			second.Lease.Close()
			other := pid + 1
			f.record.Jobs.Daemon.PID = &other
			f.save(t)
			if wrong, err := Prepare(f.scope, f.helper, pins); err == nil {
				wrong.Lease.Close()
				t.Fatal("different PID admitted")
			}
		})
	}
}
func TestInheritedLeaseHandshakeAndAdoption(t *testing.T) {
	f := makeFixture(t, "keyd")
	l := f.prepare(t)
	env := map[string]string{}
	for _, entry := range l.Environment {
		k, v, _ := strings.Cut(entry, "=")
		env[k] = v
	}
	identity := admin.ServiceIdentity{OwnerID: f.scope.Owner, Release: f.record.Configuration.Release}
	duplicate, err := syscall.Dup(int(l.Lease.Fd()))
	if err != nil {
		t.Fatal(err)
	}
	env["LOCALDOT_SERVICE_LEASE_FD"] = strconv.Itoa(duplicate)
	adopted, err := Adopt(identity, "keyd", func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	// Separate descriptors share the kernel lock without double-closing a descriptor number.
	defer adopted.Close()
	var out bytes.Buffer
	nonce := strings.Repeat("f", 64)
	if code := RunLock([]string{f.scope.State, f.scope.Home, f.scope.Owner, "keyd", nonce}, l.Lease, &out); code != 0 || out.String() != "locked:"+nonce+"\n" {
		t.Fatal("inherited handshake failed")
	}
	f.record.Phase = "stopping"
	f.save(t)
	if _, err := Adopt(identity, "keyd", func(k string) string { return env[k] }); err == nil {
		t.Fatal("late app startup admitted")
	}
}

func TestActualExecKeepsLeaseAndDoesNotPassItToChildren(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node required for exec fixture")
	}
	node, err = filepath.EvalSymlinks(node)
	if err != nil {
		t.Fatal(err)
	}
	f := makeFixture(t, "daemon")
	// Hosted tool caches can be group-writable or owned by a different build user. The managed launcher correctly rejects those;
	// use a private executable fixture instead of weakening the production ownership check.
	info, err := os.Stat(node)
	if err != nil {
		t.Fatal(err)
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("Node fixture has no ownership metadata")
	}
	if info.Mode().Perm()&0o022 != 0 || (st.Uid != 0 && int(st.Uid) != os.Getuid()) {
		nodeBytes, err := os.ReadFile(node)
		if err != nil {
			t.Fatal(err)
		}
		node = filepath.Join(filepath.Dir(f.scope.State), "node")
		if err := os.WriteFile(node, nodeBytes, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	f.record.Configuration.Settings.Node = node
	f.record.Configuration.Configuration = configurationID(f.record.Configuration)
	f.scope.Configuration = f.record.Configuration.Configuration
	f.save(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.helper, body, 0o700); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(filepath.Dir(filepath.Dir(filepath.Dir(f.helper))), "app", "dist", "daemon.mjs")
	if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
		t.Fatal(err)
	}
	script := `import fs from 'node:fs';import{spawn}from'node:child_process';
if(process.env.FAKE_SECRET||process.env.NODE_OPTIONS||process.cwd()!==process.env.LOCALDOT_HOME||!fs.fstatSync(Number(process.env.LOCALDOT_SERVICE_LEASE_FD)).isFile())process.exit(9);
const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'ignore'});
console.log('ready:'+process.pid+':'+child.pid);setInterval(()=>{},1000);`
	if err := os.WriteFile(entry, []byte(script), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(f.helper, f.scope.State, f.scope.Home, f.scope.Owner, f.scope.Configuration, "daemon")
	cmd.Env = append(os.Environ(), "LOCALDOT_SERVICE_EXEC_FIXTURE=1", "FAKE_SECRET=fake-only", "NODE_OPTIONS=--require=/does-not-exist")
	for _, role := range []string{"DESKTOP", "GATE", "BROWSER", "BRAIN"} {
		cmd.Env = append(cmd.Env, "LOCALDOT_"+role+"_IMAGE="+pins(""))
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(io.LimitReader(stdout, 256)).ReadString('\n'); ready <- line }()
	var line string
	select {
	case line = <-ready:
	case <-time.After(5 * time.Second):
		t.Fatal("exec fixture timed out")
	}
	parts := strings.Split(strings.TrimSpace(line), ":")
	if len(parts) != 3 || parts[0] != "ready" {
		cmd.Process.Kill()
		cmd.Wait() // os/exec must finish copying stderr before the buffer is read.
		t.Fatalf("no ready: %q %s", line, &stderr)
	}
	pid, _ := strconv.Atoi(parts[1])
	child, _ := strconv.Atoi(parts[2])
	if pid != cmd.Process.Pid || child < 1 {
		t.Fatal("exec changed PID or lost child")
	}
	defer syscall.Kill(child, syscall.SIGKILL)
	if other, err := installlock.AcquireService(f.scope.State, f.scope.Owner, "daemon"); !errors.Is(err, installlock.ErrBusy) {
		if other != nil {
			other.Close()
		}
		t.Fatal("exec lost lifetime lock")
	}
	cmd.Process.Kill()
	cmd.Wait()
	if err := syscall.Kill(child, 0); err != nil {
		t.Fatal("child exited before inheritance observation")
	}
	other, err := installlock.AcquireService(f.scope.State, f.scope.Owner, "daemon")
	if err != nil {
		t.Fatal("child inherited lifetime lease")
	}
	other.Close()
}

func TestKeydStartsWithThePlatformVault(t *testing.T) {
	if vaultMode("darwin") != "keychain" || vaultMode("linux") != "auto" {
		t.Fatal("installed keyd would start with the wrong vault")
	}
}
