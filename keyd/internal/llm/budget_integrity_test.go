package llm

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestInvalidTaskLimitsCannotCreateOrRaiseAnAccount(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	if err := b.Begin("existing", "session", 2); err != nil {
		t.Fatal(err)
	}
	for _, limit := range []float64{-1, 0.0000001, 10_001, math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := b.Begin("new", "session", limit); err == nil {
			t.Fatalf("invalid limit %v changed the account", limit)
		}
		if _, ok := b.Task("new"); ok {
			t.Fatal("invalid limit attached a new cell")
		}
		info, _ := b.Task("existing")
		if info.LimitUSD != 2 {
			t.Fatalf("invalid limit changed the previous account: %+v", info)
		}
	}
}

func TestCorruptSpendLedgersCannotBecomeSpendable(t *testing.T) {
	for _, data := range []string{
		`{"v":3,"date":"2026-10-02","microUSD":0}`,
		`{"v":1,"date":"invalid","microUSD":0}`,
		`{"v":1,"date":"2026-10-02","microUSD":-1}`,
		`{"v":1,"date":"2026-10-02","microUSD":0,"pendingMicroUSD":1}`,
		`{"v":1,"date":"2026-10-02","microUSD":0,"tasks":{"session":{"limitMicroUSD":-1,"spentMicroUSD":0}}}`,
		`{"v":1,"date":"2026-10-02","microUSD":0,"tasks":{"session":{"limitMicroUSD":5000000,"spentMicroUSD":-1}}}`,
	} {
		path := filepath.Join(t.TempDir(), "spend.json")
		if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenBudget(path, func() Limits { return DefaultLimits }, time.Now); err == nil {
			t.Fatalf("corrupt ledger opened: %s", data)
		}
	}
}

func TestAReservationWriteFailureBlocksThisAndLaterRequests(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	dir := filepath.Join(t.TempDir(), "ledger")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	b := openBudget(t, filepath.Join(dir, "spend.json"), c)
	if err := b.Begin("cell", "session", 5); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(dir, dir+"-moved"); err != nil {
		t.Fatal(err)
	}
	if h, err := b.Reserve(context.Background(), "cell", fixed(1)); h != nil || err == nil {
		t.Fatalf("request admitted despite a failed reservation write: %v %v", h, err)
	}
	if err := os.Rename(dir+"-moved", dir); err != nil {
		t.Fatal(err)
	}
	if err := b.Check("cell"); err == nil {
		t.Fatal("a ledger failure did not fail closed for later work")
	}
}

func TestANegativeSettlementCannotRefundOrConsumeAHold(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	if err := b.Begin("cell", "session", 5); err != nil {
		t.Fatal(err)
	}
	h, err := b.Reserve(context.Background(), "cell", fixed(3_000_000))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Settle(-1); err == nil {
		t.Fatal("negative settlement accepted")
	}
	if !waits(b, "cell", fixed(3_000_000)) {
		t.Fatal("negative settlement released the pending ceiling")
	}
	if _, err := h.Settle(1_000_000); err != nil {
		t.Fatal(err)
	}
	info, _ := b.Task("cell")
	if info.SpentUSD != 1 {
		t.Fatalf("invalid settlement consumed the real settlement: %+v", info)
	}
}

func TestFailedTaskBeginKeepsThePreviousAccountAndLimit(t *testing.T) {
	for _, nextTask := range []string{"existing", "replacement"} {
		t.Run(nextTask, func(t *testing.T) {
			c := &clock{time.Date(2026, 10, 2, 12, 0, 0, 0, time.Local)}
			dir := filepath.Join(t.TempDir(), "ledger")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			b := openBudget(t, filepath.Join(dir, "spend.json"), c)
			if err := b.Begin("cell", "existing", 2); err != nil {
				t.Fatal(err)
			}
			spend(t, b, "cell", 250_000)
			if err := os.Rename(dir, dir+"-moved"); err != nil {
				t.Fatal(err)
			}
			if err := b.Begin("cell", nextTask, 8); err == nil {
				t.Fatal("the budget save should have failed")
			}
			info, ok := b.Task("cell")
			if !ok || info.ID != "existing" || info.LimitUSD != 2 || info.SpentUSD != .25 {
				t.Fatalf("failed task start changed the previous account: %+v", info)
			}
		})
	}
}
