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

// Subscribe returns a channel with room for buf events and a cancel that closes it.
func (h *Hub) Subscribe(buf int) (<-chan Event, func()) {
	s := &subscriber{ch: make(chan Event, buf)}
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

// Publish never blocks.
func (h *Hub) Publish(e Event) {
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		if s.dropped > 0 {
			select {
			case s.ch <- Event{Type: TypeDropped, Time: e.Time, Data: Dropped{Count: s.dropped}}:
				s.dropped = 0
			default:
				s.dropped++
				continue
			}
		}
		select {
		case s.ch <- e:
		default:
			s.dropped++
		}
	}
}
