package llm

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func openBudget(t *testing.T, path string, c *clock) *Budget {
	t.Helper()
	return openBudgetWith(t, path, c, Limits{PerTaskUSD: 5, PerDayUSD: 20})
}

func openBudgetWith(t *testing.T, path string, c *clock, l Limits) *Budget {
	t.Helper()
	b, err := OpenBudget(path, func() Limits { return l }, c.now)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fixed asks for a request that costs exactly micro micro-dollars.
func fixed(micro int64) Ask { return Ask{Fixed: micro} }

// waits reports whether a reservation is still waiting after a moment.
func waits(b *Budget, cell string, ask Ask) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	h, err := b.Reserve(ctx, cell, ask)
	if h != nil {
		h.Release()
	}
	return errors.Is(err, context.DeadlineExceeded)
}

// spend charges the cell's task as a request does whose provider bills cost above its hold.
func spend(t *testing.T, b *Budget, cell string, cost int64) []ExceededError {
	t.Helper()
	h, err := b.Reserve(context.Background(), cell, fixed(1))
	if err != nil {
		t.Fatal(err)
	}
	crossed, err := h.Settle(cost)
	if err != nil {
		t.Fatal(err)
	}
	return crossed
}

func TestATaskIsRequired(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	if err := b.Check("c1"); !errors.Is(err, ErrNoTask) {
		t.Fatalf("Check without a task: %v", err)
	}
	b.Begin("c1", "t1", 0)
	if err := b.Check("c1"); err != nil {
		t.Fatal(err)
	}
	b.End("c1")
	if err := b.Check("c1"); !errors.Is(err, ErrNoTask) {
		t.Fatalf("Check after End: %v", err)
	}
}

func TestTheTaskLimitStopsTheTaskAndReportsTheCrossing(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	if crossed := spend(t, b, "c1", 4_900_000); len(crossed) != 0 {
		t.Fatalf("crossed early: %+v", crossed)
	}
	crossed := spend(t, b, "c1", 200_000)
	if len(crossed) != 1 || crossed[0].Scope != "task" || crossed[0].TaskID != "t1" || crossed[0].SpentUSD != 5.1 {
		t.Fatalf("crossing: %+v", crossed)
	}
	var exceeded *ExceededError
	if err := b.Check("c1"); !errors.As(err, &exceeded) || exceeded.Scope != "task" || exceeded.LimitUSD != 5 {
		t.Fatalf("Check after the limit: %v", err)
	}
	b.Begin("c1", "t1", 10)
	if err := b.Check("c1"); err != nil {
		t.Fatalf("raising the same task's budget: %v", err)
	}
	if info, _ := b.Task("c1"); info.SpentUSD != 5.1 || info.LimitUSD != 10 {
		t.Fatalf("raised task %+v", info)
	}
	b.Begin("c1", "t2", 0)
	if info, _ := b.Task("c1"); info.SpentUSD != 0 || info.ID != "t2" {
		t.Fatalf("a new task starts at zero: %+v", info)
	}
}

func TestTheDayLimitSpansTasksAndCellsAndResetsAtMidnight(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 23, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	for i, cell := range []string{"c1", "c2", "c3", "c4", "c5"} {
		b.Begin(cell, "task-"+cell, 0)
		crossed := spend(t, b, cell, 4_000_000)
		if i == 4 && (len(crossed) != 1 || crossed[0].Scope != "day") {
			t.Fatalf("day crossing: %+v", crossed)
		}
	}
	b.Begin("c6", "task-c6", 0)
	var exceeded *ExceededError
	if err := b.Check("c6"); !errors.As(err, &exceeded) || exceeded.Scope != "day" {
		t.Fatalf("Check over the day limit: %v", err)
	}
	reopened := openBudget(t, path, c)
	reopened.Begin("c7", "task-c7", 0)
	if err := reopened.Check("c7"); !errors.As(err, &exceeded) {
		t.Fatalf("the day's spend was not restored: %v", err)
	}
	c.t = c.t.Add(2 * time.Hour)
	if err := b.Check("c6"); err != nil {
		t.Fatalf("after midnight: %v", err)
	}
	if date, spent := b.Day(); date != "2026-10-02" || spent != 0 {
		t.Fatalf("Day = %s %v", date, spent)
	}
}

func TestSettings(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s, err := OpenSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if s.Limits() != DefaultLimits || DefaultLimits != (Limits{}) {
		t.Fatalf("defaults %+v", s.Limits())
	}
	for _, bad := range []Limits{{-1, 20}, {5, -1}, {30, 20}} {
		if err := s.SetLimits(bad); err == nil {
			t.Errorf("SetLimits(%+v) accepted", bad)
		}
	}
	if err := s.SetLimits(Limits{PerTaskUSD: 2, PerDayUSD: 8}); err != nil {
		t.Fatal(err)
	}
	models := []Price{{Model: "claude-sonnet-5-5", Input: 3, Output: 15, MaxOutput: 64_000}}
	if err := s.SetModels("anthropic", models); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]Price{
		{{Model: "", Input: 1}}, {{Model: "m", Input: -1}}, {{Model: "a b", Input: 1}},
		{{Model: "m", Input: 1, Output: 2}}, {{Model: "m", Output: 1, MaxOutput: -1}}, {{Model: "m", Output: 20_000, MaxOutput: 8}},
	} {
		if err := s.SetModels("anthropic", bad); err == nil {
			t.Errorf("SetModels(%+v) accepted", bad)
		}
	}
	again, err := OpenSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if again.Limits() != (Limits{PerTaskUSD: 2, PerDayUSD: 8}) {
		t.Fatalf("limits after reopen %+v", again.Limits())
	}
	if p, ok := again.Price("anthropic", "claude-sonnet-5-5"); !ok || p.Output != 15 || p.MaxOutput != 64_000 {
		t.Fatalf("price after reopen %+v %v", p, ok)
	}
	if _, ok := again.Price("anthropic", "claude-opus-5-5"); ok {
		t.Fatal("an unlisted model has a price")
	}
}

func TestHoldsKeepRequestsSideBySideWithinTheTaskLimit(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	var holds []*Hold
	for range 3 {
		h, err := b.Reserve(context.Background(), "c1", fixed(1_500_000))
		if err != nil {
			t.Fatal(err)
		}
		holds = append(holds, h)
	}
	if !waits(b, "c1", fixed(1_500_000)) {
		t.Fatal("a fourth request of up to $1.50 did not wait beside three")
	}
	admitted := make(chan error, 1)
	go func() {
		h, err := b.Reserve(context.Background(), "c1", fixed(1_500_000))
		if h != nil {
			h.Release()
		}
		admitted <- err
	}()
	holds[0].Settle(200_000)
	if err := <-admitted; err != nil {
		t.Fatalf("the waiting request after a settle: %v", err)
	}
	holds[1].Settle(1_500_000)
	holds[2].Settle(1_500_000)
	var exceeded *ExceededError
	if _, err := b.Reserve(context.Background(), "c1", fixed(1_900_000)); !errors.As(err, &exceeded) || exceeded.Scope != "task" || exceeded.NeedUSD != 1.9 {
		t.Fatalf("a request that could cross the limit alone: %v", err)
	}
	if h, err := b.Reserve(context.Background(), "c1", fixed(1_800_000)); err != nil {
		t.Fatalf("a request that just fits: %v", err)
	} else {
		h.Release()
	}
	if info, _ := b.Task("c1"); info.SpentUSD != 3.2 {
		t.Fatalf("spent %v, want 3.2", info.SpentUSD)
	}
}

func TestParallelReservationsNeverOvershoot(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			h, err := b.Reserve(context.Background(), "c1", fixed(1_500_000))
			if err != nil {
				return
			}
			time.Sleep(5 * time.Millisecond)
			h.Settle(1_500_000)
		})
	}
	wg.Wait()
	if info, _ := b.Task("c1"); info.SpentUSD != 4.5 {
		t.Fatalf("20 parallel requests of $1.50 spent %v of a $5 task, want 4.5", info.SpentUSD)
	}
}

func TestTheDayHoldsAcrossCells(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudgetWith(t, filepath.Join(t.TempDir(), "spend.json"), c, Limits{PerTaskUSD: 5, PerDayUSD: 6})
	b.Begin("c1", "t1", 0)
	b.Begin("c2", "t2", 0)
	h, err := b.Reserve(context.Background(), "c1", fixed(4_000_000))
	if err != nil {
		t.Fatal(err)
	}
	if !waits(b, "c2", fixed(4_000_000)) {
		t.Fatal("another cell's request did not wait for the day's room")
	}
	h.Settle(4_000_000)
	var exceeded *ExceededError
	if _, err := b.Reserve(context.Background(), "c2", fixed(4_000_000)); !errors.As(err, &exceeded) || exceeded.Scope != "day" || exceeded.NeedUSD != 4 {
		t.Fatalf("a request the day cannot cover: %v", err)
	}
	if h, err := b.Reserve(context.Background(), "c2", fixed(1_500_000)); err != nil {
		t.Fatalf("a request the day can cover: %v", err)
	} else {
		h.Release()
	}
	if h, err := b.Reserve(context.Background(), "c2", Ask{PerToken: 1, Tokens: 4_000_000}); err != nil || h.Tokens() != 2_000_000 {
		t.Fatalf("a cap the day lowers to its $2 left: %v %v", h, err)
	}
}

func TestTheCapIsLoweredToTheRoomLeft(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	ask := Ask{Fixed: 100_000, PerToken: 15, Tokens: 1_000_000} // up to $15.10
	h, err := b.Reserve(context.Background(), "c1", ask)
	if err != nil || h.Tokens() != 326_666 || h.Amount() != 100_000+326_666*15 {
		t.Fatalf("admitted with %v: %v", h, err)
	}
	if !waits(b, "c1", Ask{Fixed: 100_000, PerToken: 15, Tokens: 1_000}) {
		t.Fatal("a request ran beside one that holds what is left of the task")
	}
	h.Settle(4_000_000)
	if h, err = b.Reserve(context.Background(), "c1", ask); err != nil || h.Tokens() != 60_000 {
		t.Fatalf("with $1 left: %v %v", h, err)
	}
	h.Settle(950_000)
	var exceeded *ExceededError
	if _, err := b.Reserve(context.Background(), "c1", ask); !errors.As(err, &exceeded) || exceeded.Scope != "task" || exceeded.NeedUSD != 15.1 {
		t.Fatalf("with $0.05 left, less than the input: %v", err)
	}
	if h, err := b.Reserve(context.Background(), "c1", Ask{Fixed: 20_000, PerToken: 15, Tokens: 64_000}); err != nil || h.Tokens() != 2_000 {
		t.Fatalf("a smaller request with $0.05 left: %v %v", h, err)
	}
}

func TestAWaitingRequestStopsWhenItsTaskEnds(t *testing.T) {
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("c1", "t1", 0)
	h, _ := b.Reserve(context.Background(), "c1", fixed(4_000_000))
	defer h.Release()
	result := make(chan error, 1)
	go func() {
		_, err := b.Reserve(context.Background(), "c1", fixed(4_000_000))
		result <- err
	}()
	time.Sleep(20 * time.Millisecond)
	b.End("c1")
	select {
	case err := <-result:
		if !errors.Is(err, ErrNoTask) {
			t.Fatalf("err = %v, want ErrNoTask", err)
		}
	case <-time.After(time.Second):
		t.Fatal("the waiting request did not stop when its task ended")
	}
}
