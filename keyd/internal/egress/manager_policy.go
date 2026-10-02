package egress

import (
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

// PutSecret invalidates old bindings before publishing a replacement value.
// Open and Mint share this lock, so they cannot issue credentials from a stale
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
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return 0, ErrManagerClosed
	}
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

// Model and limit changes cancel old reservations/streams before they become
// visible. New requests cannot take a fresh generation until publication ends.
// Task accounts and other credentials remain attached; only pending work ends.
func (m *Manager) SetModels(route string, models []llm.Price) error {
	if err := llm.ValidateModels(models); err != nil {
		return badRequest("%s", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrManagerClosed
	}
	return m.changePolicyLocked(gatewayCell, func() error { return m.d.Settings.SetModels(route, models) })
}

func (m *Manager) SetLimits(limits llm.Limits) error {
	if err := llm.ValidateLimits(limits); err != nil {
		return badRequest("%s", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrManagerClosed
	}
	return m.changePolicyLocked(gatewayCell, func() error { return m.d.Settings.SetLimits(limits) })
}

func gatewayCell(_ string, mc *managed) bool { return mc.policy.Gateway }

// The manager lock orders multi-cell updates; cell.current takes only one cell
// lock and releases it before consulting the vault, registry or budget. No data
// store calls back into this manager. Even if persistence fails, new requests
// receive a fresh generation using the unchanged (or fail-closed) live policy.
func (m *Manager) changePolicyLocked(affected func(string, *managed) bool, change func() error) error {
	var cells []*Cell
	for id, mc := range m.cells {
		if affected(id, mc) {
			mc.cell.mu.Lock()
			cells = append(cells, mc.cell)
		}
	}
	defer func() {
		for _, cell := range cells {
			cell.gen = newGeneration(cell.deps)
			cell.mu.Unlock()
		}
	}()
	for _, cell := range cells {
		cell.gen.stop()
	}
	return change()
}
