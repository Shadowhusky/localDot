package events

import (
	"testing"
	"time"
)

func receive(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case e, ok := <-ch:
		if !ok {
			t.Fatal("channel closed")
		}
		return e
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
	return Event{}
}

func TestPublishReachesEverySubscriber(t *testing.T) {
	h := NewHub()
	a, cancelA := h.Subscribe(4)
	b, cancelB := h.Subscribe(4)
	defer cancelA()
	defer cancelB()
	h.Publish(Event{Type: TypeKeyUse, Cell: "c1", Data: KeyUse{SecretID: "anthropic", Host: "api.anthropic.com", Method: "POST", Path: "/v1/messages", Decision: "allow"}})
	for _, ch := range []<-chan Event{a, b} {
		e := receive(t, ch)
		if e.Type != TypeKeyUse || e.Cell != "c1" || e.Time.IsZero() {
			t.Fatalf("event %+v", e)
		}
	}
}

func TestCancelClosesTheChannel(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(1)
	cancel()
	cancel()
	if _, ok := <-ch; ok {
		t.Fatal("channel still open")
	}
	h.Publish(Event{Type: TypeKeyUse})
}

func TestASlowSubscriberDropsAndIsToldHowMany(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(1)
	defer cancel()
	done := make(chan struct{})
	go func() {
		for range 5 {
			h.Publish(Event{Type: TypeKeyUse})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full subscriber")
	}
	first := receive(t, ch)
	if first.Type != TypeKeyUse {
		t.Fatalf("first event %+v", first)
	}
	h.Publish(Event{Type: TypeKeyUse})
	next := receive(t, ch)
	if next.Type != TypeDropped || next.Data.(Dropped).Count != 4 {
		t.Fatalf("next event %+v, want a dropped notice for 4", next)
	}
}
