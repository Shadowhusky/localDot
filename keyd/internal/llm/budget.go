package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var ErrNoTask = errors.New("llm: the cell has no task running")

// Ask is the most a request can cost: Fixed micro-dollars for its input, plus PerToken
// micro-dollars for each output token up to Tokens, its output cap.
type Ask struct {
	Fixed    int64
	PerToken float64
	Tokens   int64
}

func (a Ask) cost(tokens int64) int64 {
	return addMicro(a.Fixed, int64(math.Ceil(float64(tokens)*a.PerToken)))
}

type ExceededError struct {
	Scope    string  `json:"scope"`
	TaskID   string  `json:"taskId,omitempty"`
	LimitUSD float64 `json:"limitUSD"`
	SpentUSD float64 `json:"spentUSD"`
	// NeedUSD is what the refused request asked to hold, when that is what did not fit.
	NeedUSD float64 `json:"needUSD,omitempty"`
}

func (e *ExceededError) Error() string {
	if e.NeedUSD > 0 {
		return fmt.Sprintf("llm: %s budget of $%.2f has no room for a request of up to $%.2f ($%.2f spent)", e.Scope, e.LimitUSD, e.NeedUSD, e.SpentUSD)
	}
	return fmt.Sprintf("llm: %s budget of $%.2f reached ($%.2f spent)", e.Scope, e.LimitUSD, e.SpentUSD)
}

type TaskInfo struct {
	ID       string  `json:"id"`
	LimitUSD float64 `json:"limitUSD"`
	SpentUSD float64 `json:"spentUSD"`
}

// A task's limit of 0 is none, as is a day limit of 0.
type task struct {
	id           string
	limit        int64
	spent        int64
	held         int64
	pricing      *TaskSnapshot
	initialLimit int64
}

type savedTask struct {
	Limit        int64         `json:"limitMicroUSD"`
	Spent        int64         `json:"spentMicroUSD"`
	Mode         string        `json:"pricingMode,omitempty"`
	Pricing      *TaskSnapshot `json:"pricing,omitempty"`
	InitialLimit int64         `json:"initialLimitMicroUSD,omitempty"`
}

type spendFile struct {
	Pending  int64                `json:"pendingMicroUSD,omitempty"`
	V        int                  `json:"v,omitempty"`
	Tasks    map[string]savedTask `json:"tasks,omitempty"`
	Date     string               `json:"date"`
	MicroUSD int64                `json:"microUSD"`
}

// Budget enforces the per-task and per-day limits. Every request holds the most it can cost
// against its task and the day while it runs, so requests running side by side can never spend
// more together than either limit; only a provider billing more than a request's hold can.
type Budget struct {
	mu             sync.Mutex
	path           string
	limits         func() Limits
	now            func() time.Time
	day            spendFile
	dayHeld        int64
	tasks          map[string]*task
	records        map[string]*task
	attachments    map[string]*TaskLease
	persistenceErr error
	changed        chan struct{}
}

func OpenBudget(path string, limits func() Limits, now func() time.Time) (*Budget, error) {
	b := &Budget{path: path, limits: limits, now: now, tasks: map[string]*task{}, records: map[string]*task{}, attachments: map[string]*TaskLease{}, changed: make(chan struct{})}
	data, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return nil, err
	default:
		if err := json.Unmarshal(data, &b.day); err != nil {
			return nil, fmt.Errorf("budget %s: %w", path, err)
		}
		// Version 2 must not silently drop immutable policy metadata it cannot read.
		// Older ledgers keep their existing permissive read for compatibility.
		if b.day.V == 2 {
			dec := json.NewDecoder(bytes.NewReader(data))
			dec.DisallowUnknownFields()
			if err := dec.Decode(&b.day); err != nil {
				return nil, fmt.Errorf("llm: invalid version 2 budget ledger: %w", err)
			}
		}
		if b.day.V < 0 || b.day.V > 2 || b.day.MicroUSD < 0 || b.day.Pending < 0 || b.day.Pending > b.day.MicroUSD {
			return nil, errors.New("llm: invalid budget ledger")
		}
		if _, err := time.Parse("2006-01-02", b.day.Date); err != nil {
			return nil, errors.New("llm: invalid budget date")
		}
		for id, saved := range b.day.Tasks {
			if id == "" || len(id) > 256 || saved.Limit < 0 || saved.Limit > micros(10_000) || saved.Spent < 0 {
				return nil, errors.New("llm: invalid persisted task budget")
			}
			var snapshot *TaskSnapshot
			if b.day.V < 2 {
				if saved.Mode != "" || saved.Pricing != nil || saved.InitialLimit != 0 {
					return nil, errors.New("llm: pricing in legacy ledger")
				}
			} else {
				switch saved.Mode {
				case "legacy":
					if saved.Pricing != nil || saved.InitialLimit != 0 {
						return nil, errors.New("llm: invalid legacy task policy")
					}
				case "snapshot":
					if saved.Pricing == nil || saved.InitialLimit < 0 || saved.InitialLimit > micros(10_000) {
						return nil, errors.New("llm: missing immutable task policy")
					}
					var err error
					snapshot, err = NewTaskSnapshot(saved.Pricing.Pricing, saved.Pricing.Bindings)
					if err != nil {
						return nil, err
					}
				default:
					return nil, errors.New("llm: invalid task pricing mode")
				}
			}
			b.records[id] = &task{id: id, limit: saved.Limit, spent: saved.Spent, pricing: snapshot, initialLimit: saved.InitialLimit}
		}
		b.day.Tasks = nil
	}
	b.rollLocked()
	b.day.Pending = 0
	return b, nil
}

// Begin attaches a cell to its session's durable task account. Replacing a worker,
// ending its cell, or reopening keyd keeps that account's spend and explicit limit.
// A zero budget uses the existing task's limit, or the default for a new task, which is none
// unless the user set one.
func (b *Budget) Begin(cell, taskID string, budgetUSD float64) error {
	return b.begin(cell, taskID, budgetUSD, nil)
}

func (b *Budget) BeginPriced(cell, taskID string, budgetUSD float64, snapshot *TaskSnapshot) error {
	if snapshot == nil {
		return errors.New("llm: task pricing is required")
	}
	copied, err := NewTaskSnapshot(snapshot.Pricing, snapshot.Bindings)
	if err != nil {
		return err
	}
	return b.begin(cell, taskID, budgetUSD, copied)
}

func (b *Budget) begin(cell, taskID string, budgetUSD float64, pricing *TaskSnapshot) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	defer b.notifyLocked()
	b.rollLocked()
	if b.persistenceErr != nil {
		return b.persistenceErr
	}
	if cell == "" || taskID == "" || len(taskID) > 256 || math.IsNaN(budgetUSD) || math.IsInf(budgetUSD, 0) || budgetUSD < 0 || budgetUSD > 10_000 || budgetUSD > 0 && micros(budgetUSD) < 1 {
		return errors.New("llm: invalid task budget")
	}
	t := b.records[taskID]
	created := t == nil
	if t != nil && pricing != nil && (!t.pricing.equal(pricing) || budgetUSD > 0 && micros(budgetUSD) != t.initialLimit) {
		return ErrTaskPricingConflict
	}
	if previous := b.tasks[cell]; previous != nil && previous != t && (previous.pricing != nil || pricing != nil || t != nil && t.pricing != nil) {
		return ErrTaskChanged
	}
	var previousLimit int64
	if t != nil {
		previousLimit = t.limit
	}
	previousTask := b.tasks[cell]
	if t == nil {
		if budgetUSD == 0 {
			budgetUSD = b.limits().PerTaskUSD
		}
		if math.IsNaN(budgetUSD) || math.IsInf(budgetUSD, 0) || budgetUSD < 0 || budgetUSD > 10_000 || budgetUSD > 0 && micros(budgetUSD) < 1 {
			return errors.New("llm: invalid default task budget")
		}
		t = &task{id: taskID, limit: micros(budgetUSD), pricing: pricing}
		if pricing != nil {
			t.initialLimit = t.limit
		}
		b.records[taskID] = t
	} else if budgetUSD > 0 && pricing == nil {
		t.limit = micros(budgetUSD)
	}
	b.tasks[cell] = t
	if err := b.saveLocked(); err != nil {
		if created {
			delete(b.records, taskID)
		} else {
			t.limit = previousLimit
		}
		if previousTask == nil {
			delete(b.tasks, cell)
		} else {
			b.tasks[cell] = previousTask
		}
		return err
	}
	if l := b.attachments[cell]; l == nil || l.t != t {
		b.attachments[cell] = &TaskLease{b: b, cell: cell, t: t}
	}
	return nil
}

func (b *Budget) End(cell string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.tasks, cell)
	delete(b.attachments, cell)
	b.notifyLocked()
}

func (b *Budget) Task(cell string) (TaskInfo, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	t, ok := b.tasks[cell]
	if !ok {
		return TaskInfo{}, false
	}
	return TaskInfo{ID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(t.spent)}, true
}

// Check refuses a cell with no task or a spent limit, before a request's body is read.
func (b *Budget) Check(cell string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollLocked()
	if b.persistenceErr != nil {
		return b.persistenceErr
	}
	t, ok := b.tasks[cell]
	if !ok {
		return ErrNoTask
	}
	return b.spentLocked(t)
}

// Reserve admits a request and holds the most it can cost against the cell's task and the day
// until the Hold is settled or released. The hold's output cap is ask.Tokens, lowered to what the
// room left in the task and the day can pay for. A request that does not fit beside the holds of
// running requests waits for them; one whose input and a single output token do not fit in the
// room left is refused, as is every request once a limit is spent.
func (b *Budget) Reserve(ctx context.Context, cell string, ask Ask) (*Hold, error) {
	return b.reserve(ctx, cell, ask, nil)
}

func (b *Budget) reserve(ctx context.Context, cell string, ask Ask, lease *TaskLease) (*Hold, error) {
	if ask.Fixed < 0 || ask.Tokens < 0 || ask.Tokens > 1_000_000_000 || ask.PerToken < 0 || ask.PerToken > maxPrice || math.IsNaN(ask.PerToken) || math.IsInf(ask.PerToken, 0) {
		return nil, errors.New("llm: invalid request cost")
	}
	for {
		b.mu.Lock()
		if err := ctx.Err(); err != nil {
			b.mu.Unlock()
			return nil, err
		}
		if lease != nil && b.attachments[cell] != lease {
			b.mu.Unlock()
			return nil, ErrTaskChanged
		}
		b.rollLocked()
		h, err := b.reserveLocked(cell, ask)
		wait := b.changed
		b.mu.Unlock()
		if h != nil || err != nil {
			return h, err
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wait:
		}
	}
}

// reserveLocked returns a hold, a refusal, or neither when the request has to wait.
func (b *Budget) reserveLocked(cell string, ask Ask) (*Hold, error) {
	if b.persistenceErr != nil {
		return nil, b.persistenceErr
	}
	t, ok := b.tasks[cell]
	if !ok {
		return nil, ErrNoTask
	}
	if err := b.spentLocked(t); err != nil {
		return nil, err
	}
	dayLimit := micros(b.limits().PerDayUSD)
	taskRoom, dayRoom := roomLeft(t.limit, t.spent), roomLeft(dayLimit, b.day.MicroUSD)
	room := min(taskRoom, dayRoom)
	if least := ask.cost(min(ask.Tokens, 1)); least > room {
		need := usd(ask.cost(ask.Tokens))
		if least > taskRoom {
			return nil, &ExceededError{Scope: "task", TaskID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(t.spent), NeedUSD: need}
		}
		return nil, &ExceededError{Scope: "day", LimitUSD: usd(dayLimit), SpentUSD: usd(b.day.MicroUSD), NeedUSD: need}
	}
	tokens := ask.Tokens
	if ask.cost(tokens) > room {
		tokens = int64(min(float64(room-ask.Fixed)/ask.PerToken, float64(tokens)))
		for ask.cost(tokens) > room {
			tokens--
		}
	}
	amount := ask.cost(tokens)
	if t.limit > 0 && t.spent+t.held+amount > t.limit || dayLimit > 0 && b.day.MicroUSD+b.dayHeld+amount > dayLimit {
		return nil, nil
	}
	t.held += amount
	b.dayHeld += amount
	// Commit the admitted ceiling before a provider can bill the request. After a
	// process crash, an unsettled ceiling is charged in full rather than forgotten.
	if err := b.saveLocked(); err != nil {
		t.held -= amount
		b.dayHeld -= amount
		return nil, err
	}
	return &Hold{b: b, t: t, amount: amount, tokens: tokens}, nil
}

// roomLeft is what a limit leaves: everything, for no limit.
func roomLeft(limit, spent int64) int64 {
	if limit == 0 {
		return math.MaxInt64
	}
	return limit - spent
}

func (b *Budget) spentLocked(t *task) error {
	if t.limit > 0 && t.spent >= t.limit {
		return &ExceededError{Scope: "task", TaskID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(t.spent)}
	}
	if limit := micros(b.limits().PerDayUSD); limit > 0 && b.day.MicroUSD >= limit {
		return &ExceededError{Scope: "day", LimitUSD: usd(limit), SpentUSD: usd(b.day.MicroUSD)}
	}
	return nil
}

// chargeLocked adds the cost to the task and to the day, persists the day, and returns every
// limit this charge crossed.
func (b *Budget) chargeLocked(t *task, cost int64) ([]ExceededError, error) {
	if cost == 0 {
		return nil, b.saveLocked()
	}
	var crossed []ExceededError
	after := addMicro(t.spent, cost)
	if t.limit > 0 && t.spent < t.limit && after >= t.limit {
		crossed = append(crossed, ExceededError{Scope: "task", TaskID: t.id, LimitUSD: usd(t.limit), SpentUSD: usd(after)})
	}
	t.spent = after
	limit := micros(b.limits().PerDayUSD)
	before := b.day.MicroUSD
	b.day.MicroUSD = addMicro(b.day.MicroUSD, cost)
	if limit > 0 && before < limit && b.day.MicroUSD >= limit {
		crossed = append(crossed, ExceededError{Scope: "day", LimitUSD: usd(limit), SpentUSD: usd(b.day.MicroUSD)})
	}
	return crossed, b.saveLocked()
}

func (b *Budget) Day() (string, float64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollLocked()
	return b.day.Date, usd(b.day.MicroUSD)
}

// Hold is one running request's reservation.
type Hold struct {
	b      *Budget
	t      *task
	amount int64
	tokens int64
	once   sync.Once
}

// Tokens is the output cap the request was admitted with.
func (h *Hold) Tokens() int64 { return h.tokens }

// Amount is what the hold keeps from the task and the day, in micro-dollars.
func (h *Hold) Amount() int64 { return h.amount }

// Settle releases the hold and charges what the request cost to the task it was held for and to
// the day, returning every limit the charge crossed. Only the first Settle or Release counts.
func (h *Hold) Settle(cost int64) (crossed []ExceededError, err error) {
	if cost < 0 {
		return nil, errors.New("llm: a request charge cannot be negative")
	}
	h.once.Do(func() {
		b := h.b
		b.mu.Lock()
		defer b.mu.Unlock()
		b.rollLocked()
		h.t.held -= h.amount
		b.dayHeld -= h.amount
		crossed, err = b.chargeLocked(h.t, cost)
		b.notifyLocked()
	})
	return crossed, err
}

// Account is the task the hold was for and the day, as they stand now.
func (h *Hold) Account() (task, day TaskInfo) {
	b := h.b
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollLocked()
	return TaskInfo{ID: h.t.id, LimitUSD: usd(h.t.limit), SpentUSD: usd(h.t.spent)},
		TaskInfo{LimitUSD: b.limits().PerDayUSD, SpentUSD: usd(b.day.MicroUSD)}
}

// Release gives the hold back without a charge, for a request that never reached the provider.
func (h *Hold) Release() {
	h.Settle(0)
}

// notifyLocked wakes every request waiting in Reserve to look again.
func (b *Budget) notifyLocked() {
	close(b.changed)
	b.changed = make(chan struct{})
}

// rollLocked starts a new day at local midnight; holds of requests still running carry over.
func (b *Budget) rollLocked() {
	if today := b.now().Format("2006-01-02"); b.day.Date < today {
		// A lost process's pending requests may bill after midnight. Keep that
		// uncertain ceiling in the restarted day's room; live holds carry separately.
		b.day = spendFile{Date: today, MicroUSD: b.day.Pending}
	}
}

func (b *Budget) saveLocked() error {
	accounts := make(map[string]savedTask, len(b.records))
	for id, t := range b.records {
		mode := "legacy"
		if t.pricing != nil {
			mode = "snapshot"
		}
		accounts[id] = savedTask{Limit: t.limit, Spent: addMicro(t.spent, t.held), Mode: mode, Pricing: t.pricing, InitialLimit: t.initialLimit}
	}
	data, err := json.Marshal(spendFile{V: 2, Date: b.day.Date, MicroUSD: addMicro(b.day.MicroUSD, b.dayHeld), Pending: b.dayHeld, Tasks: accounts})
	if err == nil {
		err = writeAtomic(b.path, data)
	}
	if err != nil {
		b.persistenceErr = fmt.Errorf("llm: cannot save the budget ledger: %w", err)
		return b.persistenceErr
	}
	return nil
}

// addMicro saturates an unexpected charge instead of wrapping it into a credit.
func addMicro(a, b int64) int64 {
	if a > math.MaxInt64-b {
		return math.MaxInt64
	}
	return a + b
}

func micros(dollars float64) int64 { return int64(dollars*1e6 + 0.5) }

func usd(m int64) float64 { return float64(m) / 1e6 }

func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
