//go:build darwin && cgo

package nativewatch

import (
	"os"
	"path/filepath"
	"testing"
)

func resourceFixture(t *testing.T) (*resourceOwner, resourceRequest, *os.File, string) {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if os.Chmod(home, 0700) != nil {
		t.Fatal("home mode")
	}
	root := filepath.Join(home, "codex")
	profiles := filepath.Join(root, "profiles")
	work := filepath.Join(root, "work")
	run := filepath.Join(root, "run")
	profile := filepath.Join(profiles, ".owned-ABCdef")
	scratch := filepath.Join(work, ".owned-UVWxyz")
	bridge := filepath.Join(run, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
	for _, p := range []string{root, profiles, work, run, profile, scratch, bridge} {
		if os.Mkdir(p, 0700) != nil {
			t.Fatal("fixture directory")
		}
	}
	id := func(path string) resourceIdentity {
		st, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		return identityOf(st)
	}
	r := retirementRecord{V: 1, Phase: "retired", Nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Profile: resourceEntry{filepath.Base(profile), id(profile)}, Work: resourceEntry{filepath.Base(scratch), id(scratch)}, Bridge: &resourceEntry{filepath.Base(bridge), id(bridge)}}
	r.Parents.Home = id(home)
	r.Parents.Root = id(root)
	r.Parents.Profiles = id(profiles)
	r.Parents.Work = id(work)
	r.Parents.Run = id(run)
	request := resourceRequest{home, r}
	lease, err := os.Open(profiles)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lease.Close() })
	owner, err := prepareResources(request, int(lease.Fd()), scratch)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.close)
	return owner, request, lease, scratch
}

func TestResourceReceiptBecomesRecoverableOnlyAfterPublication(t *testing.T) {
	o, _, _, _ := resourceFixture(t)
	if _, err := os.Stat(o.pending); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(o.retired); !os.IsNotExist(err) {
		t.Fatal("premature retirement")
	}
	if o.publish() != nil {
		t.Fatal("publication failed")
	}
	if _, err := os.Stat(o.pending); !os.IsNotExist(err) {
		t.Fatal("active name retained")
	}
	if o.checkFile(o.retired) != nil {
		t.Fatal("retired evidence changed")
	}
}
func TestResourcePublicationRefusesChangedEvidence(t *testing.T) {
	for _, kind := range []string{"bytes", "mode", "hardlink", "replacement", "destination", "work", "bridge"} {
		t.Run(kind, func(t *testing.T) {
			o, req, _, work := resourceFixture(t)
			switch kind {
			case "bytes":
				_ = os.WriteFile(o.pending, []byte("wrong"), 0600)
			case "mode":
				_ = os.Chmod(o.pending, 0644)
			case "hardlink":
				if os.Link(o.pending, o.pending+"-alias") != nil {
					t.Fatal("hardlink fixture")
				}
			case "replacement":
				if os.Rename(o.pending, o.pending+"-old") != nil {
					t.Fatal("rename fixture")
				}
				if os.WriteFile(o.pending, o.bytes, 0600) != nil {
					t.Fatal("write fixture")
				}
			case "destination":
				if os.WriteFile(o.retired, []byte("do not replace"), 0600) != nil {
					t.Fatal("write fixture")
				}
			case "work", "bridge":
				path := work
				if kind == "bridge" {
					path = filepath.Join(req.Home, "codex", "run", req.Record.Bridge.Name)
				}
				if os.Rename(path, path+"-old") != nil || os.Mkdir(path, 0700) != nil {
					t.Fatal("replacement fixture")
				}
			}
			if o.publish() == nil {
				t.Fatal("changed resource evidence granted retirement")
			}
			if _, err := os.Lstat(o.pending); err != nil {
				t.Fatal("uncertain active evidence removed")
			}
			if kind == "destination" {
				b, _ := os.ReadFile(o.retired)
				if string(b) != "do not replace" {
					t.Fatal("destination overwritten")
				}
			}
		})
	}
}
func TestResourcePublicationAllowsIndependentlyRemovedBridge(t *testing.T) {
	o, req, _, _ := resourceFixture(t)
	if os.Remove(filepath.Join(req.Home, "codex", "run", req.Record.Bridge.Name)) != nil {
		t.Fatal("bridge fixture")
	}
	if o.publish() != nil {
		t.Fatal("independently retired bridge rejected")
	}
}
func TestResourceLeaseExcludesAnotherSupervisorAndExpiresOnLastClose(t *testing.T) {
	o, req, lease, _ := resourceFixture(t)
	other, err := os.Open(o.directory)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	args := []string{o.directory, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	if RunResourceLock(args, other, w) != 73 {
		t.Fatal("live resource lease acquired")
	}
	o.close()
	if RunResourceLock(args, other, w) != 73 {
		t.Fatal("parent's shared lease was dropped")
	}
	_ = lease.Close()
	if RunResourceLock(args, other, w) != 0 {
		t.Fatal("retired lease not reusable")
	}
	_ = req
}
