// Package events fans keyd's notices out to admin-socket subscribers, best effort: the audit log
// is the durable record, and a subscriber that falls behind is told how many events it missed.
package events

import (
	"sync"
	"time"
)

const (
	TypeKeyUse  = "key.use"
	TypeBudget  = "budget.exceeded"
	TypeAsk     = "egress.ask"
	TypeSpend   = "model.spend"
	TypeDropped = "events.dropped"
)

type Event struct {
	Type string    `json:"type"`
	Cell string    `json:"cell,omitempty"`
	Time time.Time `json:"time"`
	Data any       `json:"data,omitempty"`
}

// KeyUse is the data of @localdot/protocol's key.use event.
type KeyUse struct {
	SecretID string `json:"secretId"`
	Host     string `json:"host"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	Decision string `json:"decision"`
}

type Budget struct {
	Scope    string  `json:"scope"`
	TaskID   string  `json:"taskId,omitempty"`
	LimitUSD float64 `json:"limitUSD"`
	SpentUSD float64 `json:"spentUSD"`
}

// Ask is a connection held until the daemon answers it: where to, from which local port of the
// cell's computer (0 when unknown) and whether the gate captured it or a program asked the proxy.
type Ask struct {
	ID     string `json:"id"`
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Source int    `json:"source,omitempty"`
	Via    string `json:"via"`
}

// Spend is one settled model call. Billed marks a cost the provider stated; a limit of 0 is none.
type Spend struct {
	TaskID       string  `json:"taskId"`
	Route        string  `json:"route"`
	Model        string  `json:"model"`
	CostUSD      float64 `json:"costUSD"`
	Billed       bool    `json:"billed"`
	TaskSpentUSD float64 `json:"taskSpentUSD"`
	TaskLimitUSD float64 `json:"taskLimitUSD"`
	DaySpentUSD  float64 `json:"daySpentUSD"`
	DayLimitUSD  float64 `json:"dayLimitUSD"`
}

type Dropped struct {
	Count int `json:"count"`
}

type subscriber struct {
	ch      chan Event
	dropped int
}

type Hub struct {
	mu   sync.Mutex
	subs map[*subscriber]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: map[*subscriber]struct{}{}}
}

// Subscribe returns a channel with room for buf events, at least one, and a slot more for a drop
// notice, and a cancel that closes it.
func (h *Hub) Subscribe(buf int) (<-chan Event, func()) {
	s := &subscriber{ch: make(chan Event, max(buf, 1)+1)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	return s.ch, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, s)
			close(s.ch)
			h.mu.Unlock()
		})
	}
}

// Publish never blocks: an event a subscriber has no room for is counted as dropped. The count goes
// out as a notice in the slot kept for it, only with the next event behind it, so a subscriber that
// catches up always reads events again.
func (h *Hub) Publish(e Event) {
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		// Only Publish sends, under h.mu, so the room counted here is still there for both sends.
		if len(s.ch) >= cap(s.ch)-1 {
			s.dropped++
			continue
		}
		if s.dropped > 0 {
			s.ch <- Event{Type: TypeDropped, Time: e.Time, Data: Dropped{Count: s.dropped}}
			s.dropped = 0
		}
		s.ch <- e
	}
}
