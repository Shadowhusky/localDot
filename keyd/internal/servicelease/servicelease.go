// Package servicelease gives each installed service a kernel-held lifetime identity. The
// launcher execs, rather than spawning, the app so the PID and open lease description survive.
package servicelease

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/shadowhusky/localdot/keyd/internal/admin"
	"github.com/shadowhusky/localdot/keyd/internal/installlock"
)

var failure = errors.New("managed service lease is unavailable or not admitted")
var hashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var ownerPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var attemptPattern = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`)
var imagePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9./_-]{0,399}@sha256:[a-f0-9]{64}$`)

type Scope struct{ State, Home, Owner, Configuration, Role string }
type ownerRecord struct {
	V     int    `json:"v"`
	ID    string `json:"id"`
	State string `json:"state"`
	Home  string `json:"home"`
	UID   int    `json:"uid"`
}
type settings struct {
	State        string `json:"state"`
	Home         string `json:"home"`
	UserHome     string `json:"userHome"`
	Node         string `json:"node"`
	DockerSocket string `json:"dockerSocket"`
	UID          int    `json:"uid"`
	Port         int    `json:"port"`
	OwnerID      string `json:"ownerId"`
}
type configuration struct {
	Settings      settings              `json:"settings"`
	Release       admin.ReleaseIdentity `json:"release"`
	Configuration string                `json:"configuration"`
}
type job struct {
	Phase string `json:"phase"`
	PID   *int   `json:"pid,omitempty"`
}
type journal struct {
	V             int             `json:"v"`
	ID            string          `json:"id"`
	Configuration configuration   `json:"configuration"`
	Previous      json.RawMessage `json:"previous"`
	Phase         string          `json:"phase"`
	Jobs          struct {
		Keyd   job `json:"keyd"`
		Daemon job `json:"daemon"`
	} `json:"jobs"`
}

func safePath(path string) bool {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" || len(path) > 1024 {
		return false
	}
	for _, r := range path {
		if r < 32 || (r >= 127 && r <= 159) || r == 0xfffe || r == 0xffff {
			return false
		}
	}
	return true
}
func privateDirectory(path string) (os.FileInfo, error) {
	if !safePath(path) {
		return nil, failure
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || canonical != path {
		return nil, failure
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, failure
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || int(st.Uid) != os.Getuid() || uint32(st.Mode)&0o7777 != 0o700 {
		return nil, failure
	}
	return info, nil
}
func readRecord(directory, name string, target any) error {
	parent, err := privateDirectory(directory)
	if err != nil {
		return err
	}
	path := filepath.Join(directory, name)
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return failure
	}
	file := os.NewFile(uintptr(fd), path)
	defer file.Close()
	before, err := file.Stat()
	if err != nil {
		return failure
	}
	st, ok := before.Sys().(*syscall.Stat_t)
	if !ok || !before.Mode().IsRegular() || st.Nlink != 1 || int(st.Uid) != os.Getuid() || uint32(st.Mode)&0o7777 != 0o600 || before.Size() < 1 || before.Size() > 16384 {
		return failure
	}
	data, err := io.ReadAll(io.LimitReader(file, 16385))
	if err != nil || len(data) != int(before.Size()) || !utf8.Valid(data) {
		return failure
	}
	after, err := file.Stat()
	if err != nil {
		return failure
	}
	named, err := os.Lstat(path)
	if err != nil {
		return failure
	}
	for _, info := range []os.FileInfo{after, named} {
		current, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !os.SameFile(before, info) || info.Mode() != before.Mode() || info.Size() != before.Size() || !info.ModTime().Equal(before.ModTime()) || current.Uid != st.Uid || current.Nlink != 1 {
			return failure
		}
	}
	parentAfter, err := privateDirectory(directory)
	if err != nil || !os.SameFile(parent, parentAfter) {
		return failure
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return failure
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return failure
	}
	return nil
}
func verifyOwner(scope Scope) error {
	if !ownerPattern.MatchString(scope.Owner) || (scope.Role != "keyd" && scope.Role != "daemon") {
		return failure
	}
	if _, err := privateDirectory(scope.Home); err != nil {
		return err
	}
	var record ownerRecord
	if err := readRecord(scope.State, "service-owner.json", &record); err != nil {
		return err
	}
	if record.V != 1 || record.ID != scope.Owner || record.State != scope.State || record.Home != scope.Home || record.UID != os.Getuid() || record.UID <= 0 {
		return failure
	}
	return nil
}
func admitted(scope Scope, starting bool) (journal, error) {
	var record journal
	if verifyOwner(scope) != nil || !hashPattern.MatchString(scope.Configuration) || readRecord(scope.State, "service-journal.json", &record) != nil {
		return record, failure
	}
	c := record.Configuration
	s := c.Settings
	identity := admin.ServiceIdentity{OwnerID: s.OwnerID, Release: c.Release}
	if record.V != 1 || !attemptPattern.MatchString(record.ID) || !identity.Valid() || c.Configuration != scope.Configuration || configurationID(c) != scope.Configuration ||
		s.State != scope.State || s.Home != scope.Home || s.OwnerID != scope.Owner || s.UID != os.Getuid() ||
		!safePath(s.Node) || strings.Contains(s.Node, ":") || !safePath(s.UserHome) || !safePath(s.DockerSocket) || strings.ContainsAny(s.DockerSocket, "?#") || s.Port < 1024 || s.Port > 65535 {
		return record, failure
	}
	if starting && record.Phase != "starting" && record.Phase != "validating" {
		return record, failure
	}
	if !starting && record.Phase != "starting" && record.Phase != "validating" && record.Phase != "running" {
		return record, failure
	}
	selected := record.Jobs.Keyd
	if scope.Role == "daemon" {
		selected = record.Jobs.Daemon
	}
	if selected.Phase == "starting" && selected.PID != nil {
		return record, failure
	}
	if selected.Phase != "starting" && selected.Phase != "running" {
		return record, failure
	}
	if selected.Phase == "running" && (selected.PID == nil || *selected.PID != os.Getpid()) {
		return record, failure
	}
	// kickstart -p may return before the helper reaches exec. Accept that observation only
	// for this exact PID; validating still requires both distinct running job observations.
	if record.Phase == "validating" || record.Phase == "running" {
		k, d := record.Jobs.Keyd, record.Jobs.Daemon
		if k.Phase != "running" || d.Phase != "running" || k.PID == nil || d.PID == nil || *k.PID < 1 || *d.PID < 1 || *k.PID == *d.PID {
			return record, failure
		}
	}
	if scope.Role == "daemon" && (record.Jobs.Keyd.Phase != "running" || record.Jobs.Keyd.PID == nil || *record.Jobs.Keyd.PID < 1) {
		return record, failure
	}
	return record, nil
}

// The Keychain on macOS; elsewhere keyd chooses the keyring or its encrypted file.
func vaultMode(goos string) string {
	if goos == "darwin" {
		return "keychain"
	}
	return "auto"
}

func configurationID(c configuration) string {
	s := c.Settings
	// Match the installer's JSON.stringify field order and Unicode spelling exactly.
	value := struct {
		Identity     admin.ReleaseIdentity `json:"identity"`
		Home         string                `json:"home"`
		UserHome     string                `json:"userHome"`
		Node         string                `json:"node"`
		DockerSocket string                `json:"dockerSocket"`
		UID          int                   `json:"uid"`
		Port         int                   `json:"port"`
	}{c.Release, s.Home, s.UserHome, s.Node, s.DockerSocket, s.UID, s.Port}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if encoder.Encode(value) != nil {
		return ""
	}
	data := strings.TrimSuffix(out.String(), "\n")
	var normalized strings.Builder
	for i := 0; i < len(data); {
		if data[i] == '\\' && i+1 < len(data) {
			if strings.HasPrefix(data[i:], `\u2028`) {
				normalized.WriteString("\u2028")
				i += 6
				continue
			}
			if strings.HasPrefix(data[i:], `\u2029`) {
				normalized.WriteString("\u2029")
				i += 6
				continue
			}
			normalized.WriteString(data[i : i+2])
			i += 2
			continue
		}
		normalized.WriteByte(data[i])
		i++
	}
	data = normalized.String()
	digest := sha256.Sum256([]byte(data))
	return hex.EncodeToString(digest[:])
}

type Launch struct {
	Program                string
	Arguments, Environment []string
	Lease                  *os.File
	scope                  Scope
	attempt                string
}

// Prepare has no process effects. The caller must close Lease if exec does not replace it.
func Prepare(scope Scope, executingPath string, lookup func(string) string) (*Launch, error) {
	if err := verifyOwner(scope); err != nil {
		return nil, err
	}
	lease, err := installlock.AcquireService(scope.State, scope.Owner, scope.Role)
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			lease.Close()
		}
	}()
	record, err := admitted(scope, true)
	if err != nil {
		return nil, err
	}
	c := record.Configuration
	s := c.Settings
	release := filepath.Join(scope.State, "releases", c.Release.PackageSHA256+"-"+c.Release.ManifestSHA256)
	helper := filepath.Join(release, "keyd", "bin", "keyd")
	canonical, err := filepath.EvalSymlinks(executingPath)
	if err != nil || canonical != helper {
		return nil, failure
	}
	identity, _ := json.Marshal(admin.ServiceIdentity{OwnerID: scope.Owner, Release: c.Release})
	env := []string{"HOME=" + s.UserHome, "PATH=" + filepath.Dir(s.Node) + ":/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR=" + filepath.Join(scope.State, "tmp"), "LANG=en_US.UTF-8",
		"LOCALDOT_HOME=" + scope.Home, "LOCALDOT_SERVICE_IDENTITY=" + string(identity), "LOCALDOT_SERVICE_STATE=" + scope.State,
		"LOCALDOT_SERVICE_CONFIGURATION=" + scope.Configuration, "LOCALDOT_SERVICE_ROLE=" + scope.Role, "LOCALDOT_SERVICE_ATTEMPT=" + record.ID,
		"LOCALDOT_SERVICE_LEASE_FD=" + strconv.Itoa(int(lease.Fd()))}
	program := helper
	args := []string{helper, "-home", scope.Home, "-vault", vaultMode(runtime.GOOS), "-ports", "4760-4789"}
	if scope.Role == "daemon" {
		program = s.Node
		args = []string{s.Node, filepath.Join(release, "app", "dist", "daemon.mjs")}
		env = append(env, "DOCKER_HOST=unix://"+s.DockerSocket, "LOCALDOT_PORT="+strconv.Itoa(s.Port), "LOCALDOT_KEYD_PORTS=4760-4789", "SHARP_IGNORE_GLOBAL_LIBVIPS=1")
		for _, role := range []string{"DESKTOP", "GATE", "BROWSER", "BRAIN"} {
			name := "LOCALDOT_" + role + "_IMAGE"
			value := lookup(name)
			if !imagePattern.MatchString(value) {
				return nil, failure
			}
			env = append(env, name+"="+value)
		}
	}
	canonical, err = filepath.EvalSymlinks(program)
	if err != nil || canonical != program {
		return nil, failure
	}
	info, err := os.Lstat(program)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 || info.Mode().Perm()&0o111 == 0 {
		return nil, failure
	}
	st, okStat := info.Sys().(*syscall.Stat_t)
	if !okStat || (st.Uid != 0 && int(st.Uid) != os.Getuid()) {
		return nil, failure
	}
	ok = true
	return &Launch{program, args, env, lease, scope, record.ID}, nil
}

func (launch *Launch) Exec(execute func(string, []string, []string) error) error {
	record, err := admitted(launch.scope, true)
	if err != nil || record.ID != launch.attempt {
		return failure
	}
	if err := installlock.LockInheritedService(launch.scope.State, launch.scope.Owner, launch.scope.Role, launch.Lease); err != nil {
		return err
	}
	// os.NewFile/file descriptors default to CLOEXEC. Clear only this dedicated lease descriptor.
	if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, launch.Lease.Fd(), syscall.F_SETFD, 0); errno != 0 {
		return failure
	}
	err = execute(launch.Program, launch.Arguments, launch.Environment)
	syscall.CloseOnExec(int(launch.Lease.Fd()))
	return err
}

func RunExec(args []string, stderr io.Writer) int {
	if len(args) != 5 {
		fmt.Fprintln(stderr, "invalid managed service launch")
		return 2
	}
	path, err := os.Executable()
	if err != nil {
		return 1
	}
	launch, err := Prepare(Scope{args[0], args[1], args[2], args[3], args[4]}, path, os.Getenv)
	if err != nil {
		fmt.Fprintln(stderr, "managed service launch is not admitted")
		return 1
	}
	defer launch.Lease.Close()
	if err := launch.Exec(func(program string, argv, env []string) error {
		if err := os.Chdir(launch.scope.Home); err != nil {
			return err
		}
		return syscall.Exec(program, argv, env)
	}); err != nil {
		fmt.Fprintln(stderr, "managed service could not execute")
		return 1
	}
	return 0
}

// The installer's copy of the open file description retains the acquired lock after helper exit.
// Authority comes from private ownership, independently of a healthy installed executable.
func RunLock(args []string, inherited *os.File, output io.Writer) int {
	if len(args) != 5 || !hashPattern.MatchString(args[4]) {
		return 2
	}
	scope := Scope{State: args[0], Home: args[1], Owner: args[2], Role: args[3]}
	if verifyOwner(scope) != nil {
		return 1
	}
	err := installlock.LockInheritedService(scope.State, scope.Owner, scope.Role, inherited)
	if errors.Is(err, installlock.ErrBusy) {
		return 73
	}
	if err != nil || verifyOwner(scope) != nil {
		return 1
	}
	if _, err := fmt.Fprintf(output, "locked:%s\n", args[4]); err != nil {
		return 1
	}
	return 0
}

// Adopt is called before managed app startup. Its returned file must stay reachable until
// process exit, not merely until HTTP shutdown. Children must not inherit the lease.
func Adopt(identity admin.ServiceIdentity, role string, lookup func(string) string) (*os.File, error) {
	scope := Scope{lookup("LOCALDOT_SERVICE_STATE"), lookup("LOCALDOT_HOME"), identity.OwnerID, lookup("LOCALDOT_SERVICE_CONFIGURATION"), role}
	if lookup("LOCALDOT_SERVICE_ROLE") != role {
		return nil, failure
	}
	record, err := admitted(scope, false)
	if err != nil || record.ID != lookup("LOCALDOT_SERVICE_ATTEMPT") || record.Configuration.Release != identity.Release {
		return nil, failure
	}
	fd, err := strconv.Atoi(lookup("LOCALDOT_SERVICE_LEASE_FD"))
	if err != nil || fd < 3 || fd > 1<<20 {
		return nil, failure
	}
	file := os.NewFile(uintptr(fd), "managed-service-lease")
	if file == nil {
		return nil, failure
	}
	if err := installlock.LockInheritedService(scope.State, scope.Owner, role, file); err != nil {
		file.Close()
		return nil, err
	}
	syscall.CloseOnExec(fd)
	return file, nil
}
