package events

import (
	"sync"
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

// Publish must never block: a blocked Publish holds the hub's lock, and the next test's cancel would
// wedge on it until go test's ten-minute timeout. So this runs first and ends the run at once. The
// subscribers read now and then, so each passes through every fill level.
func TestPublishNeverBlocks(t *testing.T) {
	h := NewHub()
	var chans []<-chan Event
	for buf := range 4 {
		ch, _ := h.Subscribe(buf)
		chans = append(chans, ch)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range 300 {
			h.Publish(Event{Type: TypeKeyUse})
			for _, ch := range chans[:i%(len(chans)+1)] {
				select {
				case <-ch:
				default:
				}
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		panic("Publish blocked: the hub's lock is held, so the remaining tests would wedge")
	}
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

// Each notice counts only the events dropped since the last one, and arrives with the event after
// it, so a subscriber that catches up reads events again.
func TestADropNoticeCountsOnlyTheNewDrops(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(1)
	defer cancel()
	publish := func() { h.Publish(Event{Type: TypeKeyUse}) }
	want := func(typ string, count int) {
		t.Helper()
		e := receive(t, ch)
		if d, _ := e.Data.(Dropped); e.Type != typ || d.Count != count {
			t.Fatalf("got %+v, want %s with a count of %d", e, typ, count)
		}
	}
	for range 3 {
		publish() // one held, two dropped
	}
	want(TypeKeyUse, 0)
	publish() // the notice of two, with this event behind it
	want(TypeDropped, 2)
	publish() // dropped: the event behind the notice is still unread
	want(TypeKeyUse, 0)
	publish() // the notice of one, with this event behind it
	want(TypeDropped, 1)
	want(TypeKeyUse, 0)
}

// Publishers never block while subscribers come, read slowly, never read, and cancel mid-stream; a
// cancel that closed a channel Publish could still reach would panic here.
func TestTheHubSurvivesChurn(t *testing.T) {
	h := NewHub()
	stop := make(chan struct{})
	var pubs, subs sync.WaitGroup
	for range 8 {
		pubs.Go(func() {
			for {
				select {
				case <-stop:
					return
				default:
				}
				start := time.Now()
				h.Publish(Event{Type: TypeKeyUse, Data: KeyUse{SecretID: "s"}})
				if d := time.Since(start); d > 200*time.Millisecond {
					t.Errorf("Publish took %v", d)
				}
			}
		})
	}
	for i := range 64 {
		subs.Go(func() {
			for range 50 {
				ch, cancel := h.Subscribe(i % 4)
				for range i % 7 {
					select {
					case <-ch:
					case <-time.After(time.Millisecond):
					}
				}
				cancel()
				for range ch { // drains what was held, then ends: the channel is closed
				}
			}
		})
	}
	_, _ = h.Subscribe(1) // never read, never cancelled
	done := make(chan struct{})
	go func() {
		subs.Wait()
		close(stop)
		pubs.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the hub stalled")
	}
}

func TestSubscribeHoldsAtLeastOneEvent(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(0)
	defer cancel()
	h.Publish(Event{Type: TypeKeyUse})
	if e := receive(t, ch); e.Type != TypeKeyUse {
		t.Fatalf("got %+v", e)
	}
}
