package llm

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
)

const MaxTaskPricingBytes = 128 * 1024

var taskRoute = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var fingerprint = regexp.MustCompile(`^[a-f0-9]{64}$`)
var ErrTaskPricingConflict = errors.New("llm: task pricing conflicts with its immutable policy")
var ErrTaskChanged = errors.New("llm: task attachment changed")

// TaskPricing is supplied by the daemon. Binding identities are derived by keyd,
// never accepted from this wire object. Route IDs remain secret-backed IDs.
type TaskPricing struct {
	V      int                `json:"v"`
	Routes []TaskPricingRoute `json:"routes"`
}
type TaskPricingRoute struct {
	Route  string  `json:"route"`
	Models []Price `json:"models"`
}

func (p *TaskPricing) UnmarshalJSON(raw []byte) error {
	type plain TaskPricing
	var value plain
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&value); err != nil {
		return err
	}
	// A missing input/output price must not silently become an explicit free side.
	var wire struct {
		Routes []struct {
			Models []map[string]json.RawMessage `json:"models"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return err
	}
	for _, r := range wire.Routes {
		for _, m := range r.Models {
			for _, k := range []string{"cacheReadUSDPerMTok", "cacheWriteUSDPerMTok"} {
				if v, ok := m[k]; ok && bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
					return fmt.Errorf("llm: invalid snapshot %s", k)
				}
			}
			for _, k := range []string{"id", "inputUSDPerMTok", "outputUSDPerMTok", "maxOutputTokens"} {
				if v, ok := m[k]; !ok || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
					return fmt.Errorf("llm: snapshot model requires %s", k)
				}
			}
		}
	}
	canonical, err := CanonicalTaskPricing(TaskPricing(value))
	if err == nil {
		*p = canonical
	}
	return err
}

// CanonicalTaskPricing validates, copies and sorts before equality or persistence.
func CanonicalTaskPricing(p TaskPricing) (TaskPricing, error) {
	if p.V != 1 || len(p.Routes) < 1 || len(p.Routes) > 8 {
		return TaskPricing{}, errors.New("llm: invalid task pricing version or routes")
	}
	out := TaskPricing{V: 1, Routes: make([]TaskPricingRoute, len(p.Routes))}
	total := 0
	for i, r := range p.Routes {
		if !taskRoute.MatchString(r.Route) || len(r.Models) < 1 {
			return TaskPricing{}, errors.New("llm: invalid task pricing route")
		}
		if err := ValidateModels(r.Models); err != nil {
			return TaskPricing{}, err
		}
		total += len(r.Models)
		if total > 64 {
			return TaskPricing{}, errors.New("llm: at most 64 snapshot models")
		}
		models := slices.Clone(r.Models)
		for j := range models {
			m := &models[j]
			if m.MaxOutput < 1 {
				return TaskPricing{}, errors.New("llm: snapshot output cap is required")
			}
			// Canonicalize -0 and omitted optional cache rates without altering nonzero prices.
			if m.Input == 0 {
				m.Input = 0
			}
			if m.Output == 0 {
				m.Output = 0
			}
			if m.CacheRead == 0 {
				m.CacheRead = 0
			}
			if m.CacheWrite == 0 {
				m.CacheWrite = 0
			}
		}
		slices.SortFunc(models, func(a, b Price) int { return bytes.Compare([]byte(a.Model), []byte(b.Model)) })
		out.Routes[i] = TaskPricingRoute{Route: r.Route, Models: models}
	}
	slices.SortFunc(out.Routes, func(a, b TaskPricingRoute) int { return bytes.Compare([]byte(a.Route), []byte(b.Route)) })
	for i := 1; i < len(out.Routes); i++ {
		if out.Routes[i-1].Route == out.Routes[i].Route {
			return TaskPricing{}, errors.New("llm: duplicate snapshot route")
		}
	}
	raw, err := json.Marshal(out)
	if err != nil || len(raw) > MaxTaskPricingBytes {
		return TaskPricing{}, errors.New("llm: task pricing is too large")
	}
	return out, nil
}

// TaskSnapshot stores only nonsecret canonical policy and server-derived identities.
type TaskSnapshot struct {
	Pricing  TaskPricing       `json:"pricing"`
	Bindings map[string]string `json:"bindings"`
}

func NewTaskSnapshot(p TaskPricing, bindings map[string]string) (*TaskSnapshot, error) {
	canonical, err := CanonicalTaskPricing(p)
	if err != nil {
		return nil, err
	}
	if len(bindings) != len(canonical.Routes) {
		return nil, errors.New("llm: incomplete snapshot bindings")
	}
	out := &TaskSnapshot{Pricing: canonical, Bindings: make(map[string]string, len(bindings))}
	for _, r := range canonical.Routes {
		if !fingerprint.MatchString(bindings[r.Route]) {
			return nil, errors.New("llm: invalid snapshot binding identity")
		}
		out.Bindings[r.Route] = bindings[r.Route]
	}
	return out, nil
}
func (p *TaskSnapshot) digest() string {
	raw, _ := json.Marshal(p)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func (p *TaskSnapshot) equal(other *TaskSnapshot) bool {
	return p != nil && other != nil && p.digest() == other.digest()
}

// TaskLease pins one attachment. End followed by Begin invalidates it even for
// the same durable task. The pointed-to snapshot is private and immutable.
type TaskLease struct {
	b    *Budget
	cell string
	t    *task
}

func (l *TaskLease) Snapshot() bool { return l != nil && l.t.pricing != nil }
func (l *TaskLease) AllowsRoute(route, identity string) bool {
	return l != nil && (l.t.pricing == nil || l.t.pricing.Bindings[route] == identity)
}
func (l *TaskLease) Price(route, model string) (Price, bool) {
	if l == nil || l.t.pricing == nil {
		return Price{}, false
	}
	for _, r := range l.t.pricing.Pricing.Routes {
		if r.Route == route {
			for _, p := range r.Models {
				if p.Model == model {
					return p, true
				}
			}
		}
	}
	return Price{}, false
}
func (b *Budget) Capture(cell string) (*TaskLease, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rollLocked()
	if b.persistenceErr != nil {
		return nil, b.persistenceErr
	}
	l := b.attachments[cell]
	if l == nil {
		return nil, ErrNoTask
	}
	if err := b.spentLocked(l.t); err != nil {
		return nil, err
	}
	return l, nil
}
func (b *Budget) Current(l *TaskLease) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return l != nil && l.b == b && b.attachments[l.cell] == l
}
func (b *Budget) IsSnapshot(cell string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tasks[cell]
	return t != nil && t.pricing != nil
}
func (b *Budget) ReserveFor(ctx context.Context, l *TaskLease, ask Ask) (*Hold, error) {
	if l == nil || l.b != b {
		return nil, ErrTaskChanged
	}
	return b.reserve(ctx, l.cell, ask, l)
}

// IsLegacy excludes unattached cells: there is no legacy request to invalidate.
func (b *Budget) IsLegacy(cell string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.tasks[cell]
	return t != nil && t.pricing == nil
}
