package egress

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync"
)

var ErrAdmissionClosed = errors.New("model admission closed")
var ErrAdmissionStale = errors.New("model admission generation changed")
var ErrAdmissionBusy = errors.New("model admission still active")

const maxAdmissionEpoch uint64 = 9007199254740991
const maxActiveModelSteps uint32 = 64

type AdmissionSnapshot struct {
	GenerationID string `json:"generationId"`
	Epoch        uint64 `json:"epoch"`
	Paused       bool   `json:"paused"`
	Active       uint32 `json:"active"`
	Retired      bool   `json:"retired"`
}

// One object per immutable keyd listener generation. Credentials/Stop retirement
// still belongs to the existing generation context and surrogate registry.
// Admission is a separate non-cancelling fence: typing must finish on Pause.
type ModelAdmission struct {
	mu           sync.Mutex
	generationID string
	epoch        uint64
	paused       bool
	retired      bool
	active       uint32
}

func NewModelAdmission() *ModelAdmission {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		panic("model admission identity unavailable")
	}
	// A recovered listener cannot auto-open a saved user pause. The daemon must
	// explicitly open this fresh identity after its immutable priced task is bound.
	return &ModelAdmission{generationID: hex.EncodeToString(nonce[:]), epoch: 1, paused: true}
}
func (a *ModelAdmission) Snapshot() AdmissionSnapshot {
	a.mu.Lock()
	defer a.mu.Unlock()
	return AdmissionSnapshot{a.generationID, a.epoch, a.paused, a.active, a.retired}
}

// Pause happens before publishing Pausing. Requests which have not started
// upstream are refused by Start even when body upload preceded this fence.
func (a *ModelAdmission) Pause() (AdmissionSnapshot, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retired {
		return AdmissionSnapshot{}, ErrAdmissionStale
	}
	// Every close invalidates a previously prepared open, including a close of the
	// initially closed startup generation. Duplicate Pause cannot grant admission.
	a.paused = true
	if a.epoch >= maxAdmissionEpoch {
		a.retired = true
		return AdmissionSnapshot{}, ErrAdmissionStale
	}
	a.epoch++
	return AdmissionSnapshot{a.generationID, a.epoch, a.paused, a.active, a.retired}, nil
}
func (a *ModelAdmission) Resume(generationID string, expected uint64) (AdmissionSnapshot, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retired || a.generationID != generationID || a.epoch != expected || !a.paused {
		return AdmissionSnapshot{}, ErrAdmissionStale
	}
	if a.epoch >= maxAdmissionEpoch {
		a.retired = true
		return AdmissionSnapshot{}, ErrAdmissionStale
	}
	if a.active != 0 {
		return AdmissionSnapshot{}, ErrAdmissionBusy
	}
	a.paused = false
	a.epoch++
	return AdmissionSnapshot{a.generationID, a.epoch, a.paused, a.active, a.retired}, nil
}
func (a *ModelAdmission) Retire() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.retired = true
	a.paused = true
	if a.epoch < maxAdmissionEpoch {
		a.epoch++
	}
}

type ModelLease struct {
	owner    *ModelAdmission
	epoch    uint64
	started  bool
	released bool
}

func (a *ModelAdmission) Prepare() (*ModelLease, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.retired || a.paused {
		return nil, ErrAdmissionClosed
	}
	return &ModelLease{owner: a, epoch: a.epoch}, nil
}
func (l *ModelLease) Start() error {
	a := l.owner
	a.mu.Lock()
	defer a.mu.Unlock()
	if l.released || l.started || a.retired || a.paused || a.epoch != l.epoch {
		return ErrAdmissionClosed
	}
	if a.active >= maxActiveModelSteps {
		return ErrAdmissionBusy
	}
	a.active++
	l.started = true
	return nil
}
func (l *ModelLease) Release() {
	a := l.owner
	a.mu.Lock()
	defer a.mu.Unlock()
	if l.released {
		return
	}
	l.released = true
	if l.started {
		a.active--
	}
}
