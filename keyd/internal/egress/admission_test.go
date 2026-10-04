package egress

import (
	"errors"
	"sync"
	"testing"
)

func openedAdmission(t *testing.T) *ModelAdmission {
	t.Helper()
	a := NewModelAdmission()
	s := a.Snapshot()
	if _, err := a.Resume(s.GenerationID, s.Epoch); err != nil {
		t.Fatal(err)
	}
	return a
}
func TestModelAdmissionPauseKeepsExistingStepButRefusesNextAndUploadedBodies(t *testing.T) {
	a := openedAdmission(t)
	active, _ := a.Prepare()
	uploaded, _ := a.Prepare()
	if err := active.Start(); err != nil {
		t.Fatal(err)
	}
	s, err := a.Pause()
	if err != nil || !s.Paused || s.Active != 1 {
		t.Fatalf("pause: %#v %v", s, err)
	}
	if !errors.Is(uploaded.Start(), ErrAdmissionClosed) {
		t.Fatal("uploaded request started after Pause")
	}
	if _, err := a.Prepare(); !errors.Is(err, ErrAdmissionClosed) {
		t.Fatal("new request admitted")
	}
	if _, err := a.Resume(s.GenerationID, s.Epoch); !errors.Is(err, ErrAdmissionBusy) {
		t.Fatal("Resume while model active")
	}
	active.Release()
	active.Release()
	if _, err := a.Resume(s.GenerationID, s.Epoch); err != nil {
		t.Fatal(err)
	}
	next, err := a.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Start(); err != nil {
		t.Fatal(err)
	}
	next.Release()
}
func TestModelAdmissionStopRetirementCannotBeUndoneByLateResume(t *testing.T) {
	a := openedAdmission(t)
	s, _ := a.Pause()
	a.Retire()
	if _, err := a.Resume(s.GenerationID, s.Epoch); !errors.Is(err, ErrAdmissionStale) {
		t.Fatal("late Resume restored retired listener")
	}
	if _, err := a.Pause(); !errors.Is(err, ErrAdmissionStale) {
		t.Fatal("retired generation accepts control")
	}
	if _, err := a.Prepare(); !errors.Is(err, ErrAdmissionClosed) {
		t.Fatal("retired request")
	}
	fresh := openedAdmission(t)
	lease, err := fresh.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	lease.Release()
}
func TestModelAdmissionDelayedOldLeaseCannotStartAfterPauseAndResume(t *testing.T) {
	a := openedAdmission(t)
	old, _ := a.Prepare()
	s, _ := a.Pause()
	_, err := a.Resume(s.GenerationID, s.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	if !errors.Is(old.Start(), ErrAdmissionClosed) {
		t.Fatal("old body upload crossed Resume")
	}
	fresh, _ := a.Prepare()
	if err := fresh.Start(); err != nil {
		t.Fatal(err)
	}
	fresh.Release()
}
func TestModelAdmissionConcurrentPauseCannotUnderflowOrRestoreBusyAdmission(t *testing.T) {
	a := openedAdmission(t)
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			l, err := a.Prepare()
			if err == nil {
				_ = l.Start()
				l.Release()
				l.Release()
			}
		}()
	}
	a.Pause()
	wg.Wait()
	s := a.Snapshot()
	if s.Active != 0 || !s.Paused {
		t.Fatalf("settlement: %#v", s)
	}
	if _, err := a.Resume(s.GenerationID, s.Epoch); err != nil {
		t.Fatal(err)
	}
}

func TestModelAdmissionFreshGenerationStaysClosedAndRejectsOldControlAfterRestart(t *testing.T) {
	old := openedAdmission(t)
	oldSnapshot, _ := old.Pause()
	old.Retire()
	fresh := NewModelAdmission()
	current := fresh.Snapshot()
	if current.GenerationID == oldSnapshot.GenerationID {
		t.Fatal("generation identity reused")
	}
	if _, err := fresh.Prepare(); !errors.Is(err, ErrAdmissionClosed) {
		t.Fatal("fresh listener auto-opened")
	}
	if _, err := fresh.Resume(oldSnapshot.GenerationID, current.Epoch); !errors.Is(err, ErrAdmissionStale) {
		t.Fatal("old generation control opened new listener")
	}
	if _, err := fresh.Resume(current.GenerationID, current.Epoch); err != nil {
		t.Fatal(err)
	}
}

func TestModelAdmissionStartupCloseInvalidatesPreparedOpen(t *testing.T) {
	a := NewModelAdmission()
	before := a.Snapshot()
	closed, err := a.Pause()
	if err != nil || closed.Epoch <= before.Epoch {
		t.Fatal("startup close did not fence")
	}
	if _, err := a.Resume(before.GenerationID, before.Epoch); err == nil {
		t.Fatal("stale startup open granted admission")
	}
	if _, err := a.Resume(closed.GenerationID, closed.Epoch); err != nil {
		t.Fatal(err)
	}
}
func TestModelAdmissionBoundsRemainClosed(t *testing.T) {
	a := NewModelAdmission()
	a.epoch = maxAdmissionEpoch
	if _, err := a.Resume(a.generationID, a.epoch); err == nil || !a.Snapshot().Retired {
		t.Fatal("exhausted epoch opened")
	}
	a = NewModelAdmission()
	snap := a.Snapshot()
	if _, err := a.Resume(snap.GenerationID, snap.Epoch); err != nil {
		t.Fatal(err)
	}
	a.active = maxActiveModelSteps
	lease, err := a.Prepare()
	if err != nil {
		t.Fatal(err)
	}
	if err := lease.Start(); err == nil {
		t.Fatal("unbounded active model work")
	}
	lease.Release()
	if a.Snapshot().Active != maxActiveModelSteps {
		t.Fatal("refused lease changed active count")
	}
}
