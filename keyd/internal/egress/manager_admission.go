package egress

import (
	"encoding/json"
	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"net/http"
	"regexp"
)

var admissionTaskID = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{26}$`)
var admissionGenerationID = regexp.MustCompile(`^[0-9a-f]{32}$`)

type TaskAdmissionSnapshot struct {
	TaskID string `json:"taskId"`
	AdmissionSnapshot
}
type ModelAdmissionWrite struct {
	TaskID        string  `json:"taskId"`
	GenerationID  string  `json:"generationId"`
	State         string  `json:"state"`
	ExpectedEpoch *uint64 `json:"expectedEpoch,omitempty"`
}

func (m *Manager) ModelAdmission(cellID string) (TaskAdmissionSnapshot, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	if !ok {
		return TaskAdmissionSnapshot{}, ErrUnknownCell
	}
	lease, err := m.d.Budget.Capture(cellID)
	task, taskOK := m.d.Budget.Task(cellID)
	if err != nil || !taskOK || !admissionTaskID.MatchString(task.ID) || !lease.Snapshot() {
		return TaskAdmissionSnapshot{}, ErrAdmissionStale
	}
	mc.cell.mu.Lock()
	defer mc.cell.mu.Unlock()
	if mc.cell.closed || mc.cell.policyChanging {
		return TaskAdmissionSnapshot{}, ErrAdmissionStale
	}
	return TaskAdmissionSnapshot{TaskID: task.ID, AdmissionSnapshot: mc.cell.gen.model.Snapshot()}, nil
}
func (m *Manager) SetModelAdmission(cellID string, write ModelAdmissionWrite) (TaskAdmissionSnapshot, error) {
	if !admissionTaskID.MatchString(write.TaskID) || !admissionGenerationID.MatchString(write.GenerationID) || (write.State != "paused" && write.State != "open") || (write.State == "open" && write.ExpectedEpoch == nil) || (write.ExpectedEpoch != nil && (*write.ExpectedEpoch == 0 || *write.ExpectedEpoch > 9007199254740991)) {
		return TaskAdmissionSnapshot{}, badRequest("invalid model admission owner")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	if !ok {
		return TaskAdmissionSnapshot{}, ErrUnknownCell
	}
	lease, err := m.d.Budget.Capture(cellID)
	task, taskOK := m.d.Budget.Task(cellID)
	if err != nil || !taskOK || task.ID != write.TaskID || !lease.Snapshot() {
		return TaskAdmissionSnapshot{}, ErrAdmissionStale
	}
	mc.cell.mu.Lock()
	defer mc.cell.mu.Unlock()
	if mc.cell.closed || mc.cell.policyChanging {
		return TaskAdmissionSnapshot{}, ErrAdmissionStale
	}
	gate := mc.cell.gen.model
	current := gate.Snapshot()
	if current.Retired || current.GenerationID != write.GenerationID || (write.ExpectedEpoch != nil && current.Epoch != *write.ExpectedEpoch) {
		return TaskAdmissionSnapshot{}, ErrAdmissionStale
	}
	var next AdmissionSnapshot
	if write.State == "paused" {
		next, err = gate.Pause()
	} else {
		next, err = gate.Resume(write.GenerationID, *write.ExpectedEpoch)
	}
	if err != nil {
		return TaskAdmissionSnapshot{}, err
	}
	return TaskAdmissionSnapshot{TaskID: task.ID, AdmissionSnapshot: next}, nil
}
func (c *Cell) refuseModelAdmission(w http.ResponseWriter, line audit.Line) {
	line.Decision, line.Reason, line.Status = audit.Deny, "task_paused", http.StatusConflict
	c.record(line)
	w.Header().Set("X-Keyd-Reason", "task_paused")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusConflict)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": "task_paused"})
}
