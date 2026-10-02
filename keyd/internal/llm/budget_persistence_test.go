package llm

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTaskSpendSurvivesWorkerReplacementAndFollowup(t *testing.T) {
	for _, nextCell := range []string{"brain-1", "brain-2"} {
		t.Run(nextCell, func(t *testing.T) {
			c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
			b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
			b.Begin("brain-1", "session-1", 8)
			spend(t, b, "brain-1", 4_300_000)
			b.End("brain-1")
			b.Begin(nextCell, "session-1", 0)
			info, ok := b.Task(nextCell)
			if !ok || info.SpentUSD != 4.3 || info.LimitUSD != 8 {
				t.Fatalf("replacement/follow-up reset the session: %+v, exists %v", info, ok)
			}
		})
	}
}

func TestTaskSpendAndBudgetSurviveKeydRestart(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	b.Begin("brain-1", "session-1", 8)
	spend(t, b, "brain-1", 4_300_000)
	reopened := openBudget(t, path, c)
	reopened.Begin("brain-2", "session-1", 0)
	info, _ := reopened.Task("brain-2")
	if info.SpentUSD != 4.3 || info.LimitUSD != 8 {
		t.Fatalf("restart reset the session: %+v", info)
	}
}

func TestSessionHoldsFollowTheTaskAcrossReplacementCells(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("brain-1", "session-1", 5)
	h, err := b.Reserve(context.Background(), "brain-1", fixed(3_000_000))
	if err != nil {
		t.Fatal(err)
	}
	b.End("brain-1")
	b.Begin("brain-2", "session-1", 0)
	if !waits(b, "brain-2", fixed(3_000_000)) {
		t.Fatal("a replacement worker bypassed the old worker's pending hold")
	}
	if _, err := h.Settle(500_000); err != nil {
		t.Fatal(err)
	}
	info, _ := b.Task("brain-2")
	if info.SpentUSD != .5 {
		t.Fatalf("old worker's settled spend was lost: %+v", info)
	}
}

func TestAnUnsettledHoldIsChargedConservativelyAfterRestart(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	b.Begin("brain-1", "session-1", 5)
	if _, err := b.Reserve(context.Background(), "brain-1", fixed(3_000_000)); err != nil {
		t.Fatal(err)
	}
	// The old process is gone without settling or releasing its admitted request.
	reopened := openBudget(t, path, c)
	reopened.Begin("brain-2", "session-1", 0)
	info, _ := reopened.Task("brain-2")
	_, day := reopened.Day()
	if info.SpentUSD != 3 || day != 3 {
		t.Fatalf("pending bill was forgotten: task=%+v day=%v", info, day)
	}
	var exceeded *ExceededError
	if h, err := reopened.Reserve(context.Background(), "brain-2", fixed(2_000_001)); !errors.As(err, &exceeded) {
		if h != nil {
			h.Release()
		}
		t.Fatalf("restart admitted spending past the durable ceiling: %v", err)
	}
}

func TestReleaseRefundsTheDurableHoldButKeepsEarlierSpend(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	b.Begin("brain-1", "session-1", 5)
	spend(t, b, "brain-1", 500_000)
	h, err := b.Reserve(context.Background(), "brain-1", fixed(3_000_000))
	if err != nil {
		t.Fatal(err)
	}
	h.Release()
	reopened := openBudget(t, path, c)
	reopened.Begin("brain-2", "session-1", 0)
	info, _ := reopened.Task("brain-2")
	_, day := reopened.Day()
	if info.SpentUSD != .5 || day != .5 {
		t.Fatalf("release lost the charge or left the hold: task=%+v day=%v", info, day)
	}
	stat, err := os.Stat(path)
	if err != nil || stat.Mode().Perm() != 0o600 {
		t.Fatalf("ledger permissions: %v %v", stat, err)
	}
}

func TestAnEndedOrMidnightTaskCannotResetItsSpentBudget(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 23, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	b.Begin("brain-1", "session-1", 5)
	spend(t, b, "brain-1", 5_000_000)
	b.End("brain-1")
	c.t = c.t.Add(2 * time.Hour)
	b.Begin("brain-2", "session-1", 0)
	var exceeded *ExceededError
	if err := b.Check("brain-2"); !errors.As(err, &exceeded) || exceeded.Scope != "task" {
		t.Fatalf("ending the cell or rolling the day reset a spent session: %v", err)
	}
	if _, spent := b.Day(); spent != 0 {
		t.Fatalf("the new day's charge was %v", spent)
	}
}

func TestBudgetRefusesPaidWorkWhenTheLedgerCannotBeSaved(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "missing-parent", "spend.json")
	b := openBudget(t, path, c)
	b.Begin("brain-1", "session-1", 5)
	if h, err := b.Reserve(context.Background(), "brain-1", fixed(1)); err == nil {
		if h != nil {
			h.Release()
		}
		t.Fatal("paid work was admitted before its ceiling could be saved")
	}
}

func TestAnUnsettledHoldCarriesIntoTheRestartedDaysBudget(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 23, 59, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudgetWith(t, path, c, Limits{PerTaskUSD: 5, PerDayUSD: 5})
	b.Begin("brain-1", "session-1", 5)
	if _, err := b.Reserve(context.Background(), "brain-1", fixed(4_000_000)); err != nil {
		t.Fatal(err)
	}
	c.t = c.t.Add(2 * time.Minute)
	reopened := openBudgetWith(t, path, c, Limits{PerTaskUSD: 5, PerDayUSD: 5})
	reopened.Begin("brain-2", "new-session", 5)
	if _, spent := reopened.Day(); spent != 4 {
		t.Fatalf("a pending bill vanished at restart/midnight: %v", spent)
	}
	var exceeded *ExceededError
	if h, err := reopened.Reserve(context.Background(), "brain-2", fixed(2_000_000)); !errors.As(err, &exceeded) || exceeded.Scope != "day" {
		if h != nil {
			h.Release()
		}
		t.Fatalf("new day admitted work past the pending ceiling: %v", err)
	}
}

func TestABackwardClockCannotResetTheDaysSpend(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 0, 1, 0, 0, time.Local)}
	b := openBudgetWith(t, filepath.Join(t.TempDir(), "spend.json"), c, Limits{PerTaskUSD: 5, PerDayUSD: 5})
	b.Begin("brain-1", "session-1", 5)
	spend(t, b, "brain-1", 4_000_000)
	c.t = c.t.Add(-2 * time.Minute)
	b.Begin("brain-2", "session-2", 5)
	if _, spent := b.Day(); spent != 4 {
		t.Fatalf("clock correction reset the day's spend: %v", spent)
	}
	var exceeded *ExceededError
	if h, err := b.Reserve(context.Background(), "brain-2", fixed(2_000_000)); !errors.As(err, &exceeded) || exceeded.Scope != "day" {
		if h != nil {
			h.Release()
		}
		t.Fatalf("clock correction admitted more spending: %v", err)
	}
}

func TestACanceledRequestNeverAcquiresADurableHold(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	b.Begin("brain-1", "session-1", 5)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if h, err := b.Reserve(ctx, "brain-1", fixed(3_000_000)); h != nil || !errors.Is(err, context.Canceled) {
		if h != nil {
			h.Release()
		}
		t.Fatalf("canceled request acquired a hold: %v %v", h, err)
	}
	reopened := openBudget(t, path, c)
	reopened.Begin("brain-2", "session-1", 0)
	info, _ := reopened.Task("brain-2")
	if info.SpentUSD != 0 {
		t.Fatalf("canceled request left a durable charge: %+v", info)
	}
}

func TestInvalidAsksCannotCreditOrOverflowTheBudget(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	b.Begin("brain-1", "session-1", 5)
	for _, ask := range []Ask{
		{Fixed: -1}, {PerToken: -1, Tokens: 1}, {Tokens: -1},
		{PerToken: math.NaN(), Tokens: 1}, {PerToken: math.Inf(1), Tokens: 1},
		{PerToken: math.MaxFloat64, Tokens: 2}, {Tokens: 1_000_000_001},
	} {
		if h, err := b.Reserve(context.Background(), "brain-1", ask); h != nil || err == nil {
			if h != nil {
				h.Release()
			}
			t.Fatalf("invalid ask admitted: %+v / %v", ask, err)
		}
	}
}

func TestAnUnexpectedLargeChargeExhaustsTheBudgetWithoutOverflow(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	b.Begin("brain-1", "session-1", 5)
	spend(t, b, "brain-1", 1)
	spend(t, b, "brain-1", math.MaxInt64)
	var exceeded *ExceededError
	if err := b.Check("brain-1"); !errors.As(err, &exceeded) {
		t.Fatalf("charge overflow reopened the live budget: %v", err)
	}
	reopened := openBudget(t, path, c)
	reopened.Begin("brain-2", "session-1", 0)
	if err := reopened.Check("brain-2"); !errors.As(err, &exceeded) {
		t.Fatalf("overflow was lost on restart: %v", err)
	}
}
