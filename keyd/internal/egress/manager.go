package egress

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/cellca"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"github.com/shadowhusky/localdot/keyd/internal/policy"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

var (
	ErrUnknownCell   = errors.New("egress: no such cell")
	ErrCellExists    = errors.New("egress: the cell is already open")
	ErrManagerClosed = errors.New("egress: the cell manager is closed")
	cellIDPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
)

// RequestError is a request the manager refuses as malformed.
type RequestError struct{ msg string }

func (e *RequestError) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return &RequestError{msg: fmt.Sprintf(format, args...)}
}

// PortRange bounds the listener ports the daemon may ask for. The zero range allows only port 0,
// a free port, which tests use.
type PortRange struct{ Min, Max int }

var DefaultPorts = PortRange{Min: 4760, Max: 4789}

type ManagerDeps struct {
	Deps
	Ports PortRange
	// CellsDir holds <cell>/ca.pem, the public half of each cell's CA.
	CellsDir string
}

type OpenRequest struct {
	CellID  string   `json:"cellId"`
	Role    string   `json:"role"`
	Port    int      `json:"port"`
	Secrets []string `json:"secrets"`
}

// Opened is everything a cell holds: its listener, its proxy token, the public half of its CA
// and one surrogate per secret.
type Opened struct {
	CellID     string            `json:"cellId"`
	Port       int               `json:"port"`
	ProxyToken string            `json:"proxyToken"`
	CACertPEM  string            `json:"caCertPem"`
	CAPath     string            `json:"caPath"`
	Surrogates map[string]string `json:"surrogates"`
}

type SurrogateInfo struct {
	SecretID    string `json:"secretId"`
	SurrogateID string `json:"surrogateId"`
}

type CellInfo struct {
	CellID     string          `json:"cellId"`
	Role       string          `json:"role"`
	Port       int             `json:"port"`
	Intercepts []string        `json:"intercepts"`
	Surrogates []SurrogateInfo `json:"surrogates"`
	Task       *llm.TaskInfo   `json:"task,omitempty"`
}

type managed struct {
	cell   *Cell
	policy policy.Policy
	ca     *cellca.CA
	caDir  string
}

// Manager opens, lists, revokes and closes cells.
type Manager struct {
	d      ManagerDeps
	mu     sync.Mutex
	cells  map[string]*managed
	closed bool
}

func NewManager(d ManagerDeps) *Manager {
	return &Manager{d: d, cells: map[string]*managed{}}
}

func (m *Manager) Open(req OpenRequest) (Opened, error) {
	if !cellIDPattern.MatchString(req.CellID) {
		return Opened{}, badRequest("cell id %q: want 1-64 of A-Z a-z 0-9 _ - starting with a letter or digit", req.CellID)
	}
	p, err := policy.ForRole(policy.Role(req.Role))
	if err != nil {
		return Opened{}, badRequest("%v", err)
	}
	if req.Port < m.d.Ports.Min || req.Port > m.d.Ports.Max {
		return Opened{}, badRequest("port %d is outside %d-%d", req.Port, m.d.Ports.Min, m.d.Ports.Max)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return Opened{}, ErrManagerClosed
	}
	if _, ok := m.cells[req.CellID]; ok {
		return Opened{}, ErrCellExists
	}
	bindings, err := m.bindings(p, req.Secrets)
	if err != nil {
		return Opened{}, err
	}
	var hosts []string
	for _, b := range bindings {
		hosts = append(hosts, b.Hosts...)
	}
	slices.Sort(hosts)
	ca, err := cellca.New(req.CellID, slices.Compact(hosts))
	if err != nil {
		return Opened{}, err
	}
	token, err := newToken()
	if err != nil {
		return Opened{}, err
	}
	cell, err := Open(Config{CellID: req.CellID, Policy: p, Port: req.Port, Token: token, CA: ca}, m.d.Deps)
	if err != nil {
		return Opened{}, err
	}
	mc := &managed{cell: cell, policy: p, ca: ca, caDir: filepath.Join(m.d.CellsDir, req.CellID)}
	caPath := filepath.Join(mc.caDir, "ca.pem")
	surrogates, err := m.mint(mc, bindings)
	if err == nil {
		err = writeCA(mc.caDir, caPath, ca.CertPEM())
	}
	if err != nil {
		m.d.Registry.RevokeCell(req.CellID)
		cell.Close()
		os.RemoveAll(mc.caDir)
		return Opened{}, err
	}
	m.cells[req.CellID] = mc
	m.admin(req.CellID, cell.Port(), "cell-open", fmt.Sprintf("role %s, secrets %s", req.Role, strings.Join(req.Secrets, ",")))
	return Opened{
		CellID: req.CellID, Port: cell.Port(), ProxyToken: token,
		CACertPEM: string(ca.CertPEM()), CAPath: caPath, Surrogates: surrogates,
	}, nil
}

// Close drops the cell's surrogates, task, listener, connections and CA.
func (m *Manager) Close(cellID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.closeLocked(cellID)
}

// Cleanup shares the lifecycle lock with Open/Mint/BeginTask, so an old cell
// cannot remove the CA or credentials of a replacement with the same ID.
func (m *Manager) closeLocked(cellID string) error {
	mc, ok := m.cells[cellID]
	delete(m.cells, cellID)
	if !ok {
		return ErrUnknownCell
	}
	m.d.Registry.RevokeCell(cellID)
	m.d.Budget.End(cellID)
	port := mc.cell.Port()
	err := mc.cell.Close()
	os.RemoveAll(mc.caDir)
	m.admin(cellID, port, "cell-close", "")
	return err
}

// Revoke is the kill switch: the cell's surrogates are dropped, its task ends (the keyless local
// routes stop too) and every upstream connection and tunnel it has is closed. Its listener and CA
// stay, so its processes keep their web egress: the daemon's Stop pauses them as well.
func (m *Manager) Revoke(cellID string) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	if !ok {
		return 0, ErrUnknownCell
	}
	n := m.d.Registry.RevokeCell(cellID)
	m.d.Budget.End(cellID)
	mc.cell.Revoke()
	m.admin(cellID, mc.cell.Port(), "cell-revoke", fmt.Sprintf("%d surrogate(s) dropped, task ended", n))
	return n, nil
}

// Mint gives a running cell new surrogates. A secret bound to a host the cell's CA does not
// cover needs the cell to be opened again.
func (m *Manager) Mint(cellID string, secrets []string) (map[string]string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	if !ok {
		return nil, ErrUnknownCell
	}
	bindings, err := m.bindings(mc.policy, secrets)
	if err != nil {
		return nil, err
	}
	covered := mc.ca.Hosts()
	for _, b := range bindings {
		for _, h := range b.Hosts {
			if !slices.Contains(covered, h) {
				return nil, badRequest("secret %s is bound to %s, which this cell's CA does not cover; open the cell again", b.SecretID, h)
			}
		}
	}
	out, err := m.mint(mc, bindings)
	if err == nil {
		m.admin(cellID, mc.cell.Port(), "cell-mint", strings.Join(secrets, ","))
	}
	return out, err
}

func (m *Manager) BeginTask(cellID, taskID string, budgetUSD float64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	if !ok {
		return ErrUnknownCell
	}
	if taskID == "" || len(taskID) > 128 {
		return badRequest("task id must be 1-128 characters")
	}
	if math.IsNaN(budgetUSD) || math.IsInf(budgetUSD, 0) || budgetUSD < 0 || budgetUSD > 10_000 || budgetUSD > 0 && math.Floor(budgetUSD*1e6+0.5) < 1 {
		return badRequest("budget must be finite, nonnegative and no more than $10,000; positive budgets must round to at least one micro-dollar")
	}
	if err := m.d.Budget.Begin(cellID, taskID, budgetUSD); err != nil {
		return err
	}
	m.admin(cellID, mc.cell.Port(), "task-begin", taskID)
	return nil
}

func (m *Manager) EndTask(cellID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	if !ok {
		return ErrUnknownCell
	}
	m.d.Budget.End(cellID)
	m.admin(cellID, mc.cell.Port(), "task-end", "")
	return nil
}

func (m *Manager) Cell(cellID string) (CellInfo, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	mc, ok := m.cells[cellID]
	if !ok {
		return CellInfo{}, false
	}
	return m.infoLocked(cellID, mc), true
}

func (m *Manager) infoLocked(cellID string, mc *managed) CellInfo {
	info := CellInfo{CellID: cellID, Role: string(mc.policy.Role), Port: mc.cell.Port(), Intercepts: mc.ca.Hosts(), Surrogates: []SurrogateInfo{}}
	for _, e := range m.d.Registry.ForCell(cellID) {
		info.Surrogates = append(info.Surrogates, SurrogateInfo{SecretID: e.Binding.SecretID, SurrogateID: e.ID})
	}
	slices.SortFunc(info.Surrogates, func(a, b SurrogateInfo) int { return strings.Compare(a.SecretID, b.SecretID) })
	if t, ok := m.d.Budget.Task(cellID); ok {
		info.Task = &t
	}
	return info
}

func (m *Manager) Cells() []CellInfo {
	m.mu.Lock()
	defer m.mu.Unlock()
	ids := make([]string, 0, len(m.cells))
	for id := range m.cells {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	out := make([]CellInfo, 0, len(ids))
	for _, id := range ids {
		out = append(out, m.infoLocked(id, m.cells[id]))
	}
	return out
}

// CloseAll shuts down the manager and every cell. Once shutdown begins, Open
// cannot race past the final snapshot and leave a listener or credential behind.
func (m *Manager) CloseAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = true
	for id := range m.cells {
		m.closeLocked(id)
	}
}

func (m *Manager) bindings(p policy.Policy, secrets []string) ([]keys.Binding, error) {
	if len(secrets) > 32 {
		return nil, badRequest("at most 32 secrets per cell")
	}
	var out []keys.Binding
	for i, id := range secrets {
		if slices.Contains(secrets[:i], id) {
			return nil, badRequest("secret %s is listed twice", id)
		}
		rec, ok := m.d.Vault.Record(id)
		if !ok {
			return nil, badRequest("no secret %s", id)
		}
		if rec.Kind == vault.KindLLM && !p.Gateway {
			return nil, badRequest("a %s cell cannot use the LLM gateway, so it cannot hold %s", p.Role, id)
		}
		if rec.Kind == vault.KindHTTP && !p.Web {
			return nil, badRequest("a %s cell reaches only the LLM gateway, so it cannot hold %s", p.Role, id)
		}
		b, err := keys.FromRecord(rec)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, nil
}

func (m *Manager) mint(mc *managed, bindings []keys.Binding) (map[string]string, error) {
	out := map[string]string{}
	for _, b := range bindings {
		e, err := m.d.Registry.Mint(mc.cell.ID(), b)
		if err != nil {
			return nil, err
		}
		out[b.SecretID] = e.Token
	}
	return out, nil
}

func (m *Manager) admin(cellID string, port int, reason, detail string) {
	if _, err := m.d.Audit.Write(audit.Line{Kind: audit.KindAdmin, Cell: cellID, Port: port, Decision: audit.Allow, Reason: reason, Detail: detail}); err != nil {
		log.Printf("keyd: audit write failed: %v", err)
	}
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func writeCA(dir, path string, pemBytes []byte) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, pemBytes, 0o644)
}
