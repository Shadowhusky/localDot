package egress

import (
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// PutSecret invalidates old bindings before publishing a replacement value.
// Open and Mint share the publication lock, so they cannot issue credentials from a stale
// record while the vault write is in progress. A failed write still revokes old
// surrogates: a backend error cannot promise that the old value is intact.
func (m *Manager) PutSecret(rec vault.Record, value []byte) (int, error) {
	b, err := keys.FromRecord(rec)
	if err != nil {
		return 0, badRequest("%s", err)
	}
	if err := keys.ValidValueFor(b, value); err != nil {
		return 0, badRequest("%s", err)
	}
	return m.changeSecret(rec.ID, rec.Kind, func() error { return m.d.Vault.Put(rec, value) })
}

func (m *Manager) DeleteSecret(id string) (int, error) {
	return m.changeSecret(id, "", func() error { return m.d.Vault.Delete(id) })
}

func (m *Manager) changeSecret(id string, nextKind vault.Kind, change func() error) (int, error) {
	m.policyMu.Lock()
	defer m.policyMu.Unlock()
	previous, _ := m.d.Vault.Record(id)
	webBinding := nextKind == vault.KindHTTP || previous.Kind == vault.KindHTTP
	revoked := 0
	err := m.changePolicyLocked(func(cellID string, mc *managed) bool {
		// A newly bound HTTP host changes the scrub set even in a cell that
		// holds no surrogate. Its pre-existing streams/tunnels must end too.
		if webBinding && mc.policy.Web {
			return true
		}
		for _, entry := range m.d.Registry.ForCell(cellID) {
			if entry.Binding.SecretID == id {
				return true
			}
		}
		return false
	}, func() error {
		revoked = m.d.Registry.RevokeSecret(id)
		return change()
	})
	return revoked, err
}

// Global model changes cancel legacy attachments; priced tasks keep their frozen
// table and active streams. Limit changes still cancel every gateway generation.
// New affected requests wait for publication; accounts and credentials stay attached.
func (m *Manager) SetModels(route string, models []llm.Price) error {
	if err := llm.ValidateModels(models); err != nil {
		return badRequest("%s", err)
	}
	m.policyMu.Lock()
	defer m.policyMu.Unlock()
	return m.changePolicyLocked(func(id string, mc *managed) bool { return mc.policy.Gateway && m.d.Budget.IsLegacy(id) }, func() error { return m.d.Settings.SetModels(route, models) })
}

func (m *Manager) SetLimits(limits llm.Limits) error {
	if err := llm.ValidateLimits(limits); err != nil {
		return badRequest("%s", err)
	}
	m.policyMu.Lock()
	defer m.policyMu.Unlock()
	return m.changePolicyLocked(gatewayCell, func() error { return m.d.Settings.SetLimits(limits) })
}

func gatewayCell(_ string, mc *managed) bool { return mc.policy.Gateway }

// policyMu orders multi-cell updates and prevents new issuance. Existing cells
// retain a canceled generation throughout persistence, without holding their
// locks or the lifecycle lock: Revoke and Close remain available if storage
// stalls. Publication must never reopen a cell that Close retired in the meantime.
func (m *Manager) changePolicyLocked(affected func(string, *managed) bool, change func() error) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrManagerClosed
	}
	var cells []*Cell
	for id, mc := range m.cells {
		if affected(id, mc) {
			mc.cell.mu.Lock()
			mc.cell.policyChanging = true
			mc.cell.gen.stop()
			mc.cell.mu.Unlock()
			cells = append(cells, mc.cell)
		}
	}
	m.mu.Unlock()
	defer func() {
		for _, cell := range cells {
			cell.mu.Lock()
			cell.policyChanging = false
			if !cell.closed {
				cell.gen = newGeneration(cell.deps)
			}
			cell.mu.Unlock()
		}
	}()
	return change()
}
