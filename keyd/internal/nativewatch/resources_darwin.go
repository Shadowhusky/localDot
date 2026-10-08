//go:build darwin

package nativewatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"syscall"
)

var ErrResources = errors.New("native resource ownership could not be confirmed")
var noncePattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var ownedPattern = regexp.MustCompile(`^\.owned-[A-Za-z0-9]{6}$`)
var numberPattern = regexp.MustCompile(`^(0|[1-9][0-9]{0,24})$`)

type resourceIdentity struct {
	Dev   string `json:"dev"`
	Ino   string `json:"ino"`
	Birth string `json:"birthtimeNs"`
}
type resourceEntry struct {
	Name     string           `json:"name"`
	Identity resourceIdentity `json:"identity"`
}
type retirementRecord struct {
	V       int    `json:"v"`
	Phase   string `json:"phase"`
	Nonce   string `json:"nonce"`
	Parents struct {
		Home     resourceIdentity `json:"home"`
		Root     resourceIdentity `json:"root"`
		Profiles resourceIdentity `json:"profiles"`
		Work     resourceIdentity `json:"work"`
		Run      resourceIdentity `json:"run"`
	} `json:"parents"`
	Profile resourceEntry  `json:"profile"`
	Work    resourceEntry  `json:"work"`
	Bridge  *resourceEntry `json:"bridge"`
}
type resourceRequest struct {
	Home   string           `json:"home"`
	Record retirementRecord `json:"record"`
}
type resourceOwner struct {
	request                     resourceRequest
	directory, pending, retired string
	lease, file                 *os.File
	bytes                       []byte
	info                        os.FileInfo
}

func identityOf(info os.FileInfo) resourceIdentity {
	s, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return resourceIdentity{}
	}
	return resourceIdentity{strconv.FormatUint(uint64(s.Dev), 10), strconv.FormatUint(s.Ino, 10), strconv.FormatInt(s.Birthtimespec.Sec*1e9+s.Birthtimespec.Nsec, 10)}
}
func privateResourceDirectory(path string) (os.FileInfo, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || path == "/" {
		return nil, ErrResources
	}
	canonical, err := filepath.EvalSymlinks(path)
	if err != nil || canonical != path {
		return nil, ErrResources
	}
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	s, ok := info.Sys().(*syscall.Stat_t)
	if !ok || !info.IsDir() || int(s.Uid) != os.Getuid() || uint32(s.Mode)&0o7777 != 0700 {
		return nil, ErrResources
	}
	return info, nil
}
func validIdentity(id resourceIdentity) bool {
	return numberPattern.MatchString(id.Dev) && numberPattern.MatchString(id.Ino) && numberPattern.MatchString(id.Birth)
}
func resourceDirectory(path string, id resourceIdentity) error {
	info, err := privateResourceDirectory(path)
	if err != nil || !validIdentity(id) || identityOf(info) != id {
		return ErrResources
	}
	return nil
}
func (o *resourceOwner) check(allowAbsentBridge bool) error {
	r, home := o.request.Record, o.request.Home
	root := filepath.Join(home, "codex")
	for _, pair := range []struct {
		path string
		id   resourceIdentity
	}{
		{home, r.Parents.Home}, {root, r.Parents.Root}, {o.directory, r.Parents.Profiles},
		{filepath.Join(root, "work"), r.Parents.Work}, {filepath.Join(root, "run"), r.Parents.Run},
		{filepath.Join(o.directory, r.Profile.Name), r.Profile.Identity},
		{filepath.Join(root, "work", r.Work.Name), r.Work.Identity},
	} {
		if resourceDirectory(pair.path, pair.id) != nil {
			return ErrResources
		}
	}
	if r.Bridge != nil {
		path := filepath.Join(root, "run", r.Bridge.Name)
		if _, err := os.Lstat(path); allowAbsentBridge && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if resourceDirectory(path, r.Bridge.Identity) != nil {
			return ErrResources
		}
	}
	return nil
}
func (o *resourceOwner) sync() error {
	r, root := o.request.Record, filepath.Join(o.request.Home, "codex")
	for _, pair := range []struct {
		path string
		id   resourceIdentity
	}{
		{filepath.Join(root, "work"), r.Parents.Work}, {filepath.Join(root, "run"), r.Parents.Run},
		{o.directory, r.Parents.Profiles}, {root, r.Parents.Root}, {o.request.Home, r.Parents.Home},
	} {
		if resourceDirectory(pair.path, pair.id) != nil {
			return ErrResources
		}
		fd, err := syscall.Open(pair.path, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return ErrResources
		}
		f := os.NewFile(uintptr(fd), "native-resource-directory")
		info, statErr := f.Stat()
		ok := statErr == nil && identityOf(info) == pair.id && f.Sync() == nil
		_ = f.Close()
		if !ok || resourceDirectory(pair.path, pair.id) != nil {
			return ErrResources
		}
	}
	return nil
}
func (o *resourceOwner) checkFile(path string) error {
	for _, stat := range []func() (os.FileInfo, error){o.file.Stat, func() (os.FileInfo, error) { return os.Lstat(path) }} {
		info, err := stat()
		if err != nil {
			return ErrResources
		}
		s, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || int(s.Uid) != os.Getuid() || s.Nlink != 1 || uint32(s.Mode)&07777 != 0600 || !os.SameFile(o.info, info) || identityOf(info) != identityOf(o.info) || info.Size() != int64(len(o.bytes)) || !info.ModTime().Equal(o.info.ModTime()) {
			return ErrResources
		}
	}
	b := make([]byte, len(o.bytes)+1)
	n, err := o.file.ReadAt(b, 0)
	if !errors.Is(err, io.EOF) || n != len(o.bytes) || !bytes.Equal(b[:n], o.bytes) {
		return ErrResources
	}
	return nil
}
func (o *resourceOwner) close() {
	if o.file != nil {
		_ = o.file.Close()
	}
	if o.lease != nil {
		_ = o.lease.Close()
	}
}

// prepareResources locks the permanent profiles directory's open description and persists the
// prospective receipt under an ACTIVE name before spawn. That name never grants recovery. The
// daemon and helper share the lease; it survives either one's death until the last copy closes.
func prepareResources(request resourceRequest, inheritedFD int, cwd string) (*resourceOwner, error) {
	r := request.Record
	if r.V != 1 || r.Phase != "retired" || !noncePattern.MatchString(r.Nonce) || !ownedPattern.MatchString(r.Profile.Name) || !ownedPattern.MatchString(r.Work.Name) || (r.Bridge != nil && !noncePattern.MatchString(r.Bridge.Name)) || inheritedFD < 3 {
		return nil, ErrResources
	}
	directory := filepath.Join(request.Home, "codex", "profiles")
	if cwd != filepath.Join(request.Home, "codex", "work", r.Work.Name) {
		return nil, ErrResources
	}
	o := &resourceOwner{request: request, directory: directory, pending: filepath.Join(directory, ".active-"+r.Nonce+".json"), retired: filepath.Join(directory, ".retired-"+r.Nonce+".json")}
	if o.check(false) != nil {
		return nil, ErrResources
	}
	// Do not wrap an optional absent descriptor with os.NewFile: the runtime may already have
	// reused that number, and a File finalizer could close an unrelated runtime descriptor.
	var inherited syscall.Stat_t
	if syscall.Fstat(inheritedFD, &inherited) != nil || inherited.Mode&syscall.S_IFMT != syscall.S_IFDIR ||
		int(inherited.Uid) != os.Getuid() || uint32(inherited.Mode)&07777 != 0700 {
		return nil, ErrResources
	}
	fd := inheritedFD
	syscall.CloseOnExec(fd)
	copy, err := syscall.Dup(fd)
	if err != nil {
		return nil, ErrResources
	}
	syscall.CloseOnExec(copy)
	o.lease = os.NewFile(uintptr(copy), "native-resource-lease")
	ok := false
	defer func() {
		if !ok {
			o.close()
		}
	}()
	opened, err := o.lease.Stat()
	if err != nil || identityOf(opened) != r.Parents.Profiles {
		return nil, ErrResources
	}
	if syscall.Flock(copy, syscall.LOCK_EX|syscall.LOCK_NB) != nil || o.check(false) != nil {
		return nil, ErrResources
	}
	if _, err := os.Lstat(o.retired); !errors.Is(err, os.ErrNotExist) {
		return nil, ErrResources
	}
	o.bytes, err = json.Marshal(r)
	if err != nil || len(o.bytes) > 8191 {
		return nil, ErrResources
	}
	o.bytes = append(o.bytes, '\n')
	file, err := os.OpenFile(o.pending, os.O_RDWR|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, ErrResources
	}
	o.file = file
	if _, err = file.Write(o.bytes); err != nil {
		return nil, ErrResources
	}
	if file.Sync() != nil || o.sync() != nil || o.check(false) != nil {
		return nil, ErrResources
	}
	o.info, err = file.Stat()
	if err != nil || o.checkFile(o.pending) != nil {
		return nil, ErrResources
	}
	ok = true
	return o, nil
}

// publish is called only after process-group quiescence (or a failed Start which spawned none).
// Keep the lease through durable publication; output acknowledgement is not required for recovery.
func (o *resourceOwner) publish() error {
	if o.check(true) != nil || o.checkFile(o.pending) != nil {
		return ErrResources
	}
	if renameResource(o.pending, o.retired) != nil {
		return ErrResources
	}
	if o.sync() != nil || o.check(true) != nil || o.checkFile(o.retired) != nil {
		return ErrResources
	}
	return nil
}

// RunResourceLock acquires the same permanent directory lease for stopped-service recovery.
// It never creates/removes files and never unlocks the shared open description explicitly.
func RunResourceLock(args []string, inherited, output *os.File) int {
	if len(args) != 2 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(args[1]) || inherited == nil {
		return 2
	}
	named, err := privateResourceDirectory(args[0])
	if err != nil {
		return 2
	}
	opened, err := inherited.Stat()
	if err != nil || !opened.IsDir() || !os.SameFile(named, opened) || identityOf(named) != identityOf(opened) {
		return 2
	}
	fd := int(inherited.Fd())
	syscall.CloseOnExec(fd)
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return 73
		}
		return 2
	}
	after, err := privateResourceDirectory(args[0])
	if err != nil || !os.SameFile(named, after) || identityOf(named) != identityOf(after) {
		return 2
	}
	if _, err := io.WriteString(output, "locked:"+args[1]+"\n"); err != nil {
		return 1
	}
	return 0
}
