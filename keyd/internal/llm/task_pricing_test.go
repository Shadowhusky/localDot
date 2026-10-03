package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func priceSnapshot(t *testing.T, rate float64) *TaskSnapshot {
	t.Helper()
	s, err := NewTaskSnapshot(TaskPricing{V: 1, Routes: []TaskPricingRoute{{Route: "anthropic", Models: []Price{{Model: "model", Input: rate, Output: 2, MaxOutput: 100}}}}}, map[string]string{"anthropic": strings.Repeat("a", 64)})
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestPricedTaskRetryRetainsRaisedLimitAndPolicy(t *testing.T) {
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), &clock{time.Now()})
	p := priceSnapshot(t, 1)
	if err := b.BeginPriced("a", "session", 5, p); err != nil {
		t.Fatal(err)
	}
	p.Pricing.Routes[0].Models[0].Input = 99 // published policy owns its copy
	spend(t, b, "a", 1_000_000)
	if err := b.Begin("a", "session", 8); err != nil {
		t.Fatal(err)
	}
	if err := b.BeginPriced("a", "session", 5, priceSnapshot(t, 1)); err != nil {
		t.Fatal(err)
	}
	info, _ := b.Task("a")
	if info.LimitUSD != 8 || info.SpentUSD != 1 {
		t.Fatalf("retry reset account: %+v", info)
	}
	l, _ := b.Capture("a")
	price, ok := l.Price("anthropic", "model")
	if !ok || price.Input != 1 {
		t.Fatalf("policy mutated: %+v", price)
	}
	for _, f := range []func() error{
		func() error { return b.BeginPriced("b", "session", 8, priceSnapshot(t, 1)) },
		func() error { return b.BeginPriced("b", "session", 5, priceSnapshot(t, 9)) },
	} {
		if !errors.Is(f(), ErrTaskPricingConflict) {
			t.Fatal("conflicting initialization accepted")
		}
	}
	if _, ok := b.Task("b"); ok {
		t.Fatal("conflict attached cell")
	}
}
func TestPricedTaskSnapshotSurvivesRestartMidnightAndLostReply(t *testing.T) {
	c := &clock{time.Date(2026, 10, 2, 23, 0, 0, 0, time.UTC)}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	p := priceSnapshot(t, 1)
	if err := b.BeginPriced("a", "session", 5, p); err != nil {
		t.Fatal(err)
	}
	h, err := b.Reserve(context.Background(), "a", fixed(3_000_000))
	if err != nil {
		t.Fatal(err)
	}
	_ = h // simulate process loss: committed held amount must not be refunded
	c.t = c.t.Add(2 * time.Hour)
	reopened := openBudget(t, path, c)
	if err := reopened.BeginPriced("b", "session", 5, p); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Begin("b", "session", 8); err != nil {
		t.Fatal(err)
	}
	reopened.End("b")
	if err := reopened.Begin("c", "session", 0); err != nil {
		t.Fatal(err)
	}
	l, err := reopened.Capture("c")
	if err != nil {
		t.Fatal(err)
	}
	if !l.Snapshot() {
		t.Fatal("missing pricing downgraded account")
	}
	p2, ok := l.Price("anthropic", "model")
	info, _ := reopened.Task("c")
	if !ok || p2.Input != 1 || info.SpentUSD != 3 || info.LimitUSD != 8 {
		t.Fatalf("lost durable snapshot/account: %+v %+v", p2, info)
	}
	if _, ok := l.Price("anthropic", "globally-listed"); ok {
		t.Fatal("unknown model allowed")
	}
	raw, _ := os.ReadFile(path)
	var saved spendFile
	if err := json.Unmarshal(raw, &saved); err != nil || saved.V != 2 {
		t.Fatalf("ledger version: %s %v", raw, err)
	}
}
func TestPricedTaskLeaseCannotMoveDuringReservationWait(t *testing.T) {
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), &clock{time.Now()})
	if err := b.BeginPriced("a", "session", 5, priceSnapshot(t, 1)); err != nil {
		t.Fatal(err)
	}
	lease, _ := b.Capture("a")
	first, err := b.ReserveFor(context.Background(), lease, fixed(4_000_000))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		h, err := b.ReserveFor(ctx, lease, fixed(2_000_000))
		if h != nil {
			h.Release()
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("must wait beside hold: %v", err)
	case <-time.After(10 * time.Millisecond):
	}
	b.End("a")
	if err := b.BeginPriced("a", "next", 5, priceSnapshot(t, 7)); err != nil {
		t.Fatal(err)
	}
	if b.Current(lease) {
		t.Fatal("old attachment stayed current")
	}
	if err := <-done; !errors.Is(err, ErrTaskChanged) {
		t.Fatalf("old waiter adopted replacement: %v", err)
	}
	if _, err := first.Settle(1_000_000); err != nil {
		t.Fatal(err)
	}
	next, _ := b.Task("a")
	if next.SpentUSD != 0 {
		t.Fatal("old hold billed replacement")
	}
	if err := b.Begin("b", "session", 0); err != nil {
		t.Fatal(err)
	}
	old, _ := b.Task("b")
	if old.SpentUSD != 1 {
		t.Fatal("old settlement lost")
	}
	b.End("b")
	if err := b.Begin("b", "session", 0); err != nil {
		t.Fatal(err)
	}
	if b.Current(lease) {
		t.Fatal("same task reattach revived old lease")
	}
}
func TestPricedTaskLegacyCannotUpgradeAndConflictsDoNotWrite(t *testing.T) {
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), &clock{time.Now()})
	if err := b.Begin("legacy", "old", 5); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(b.path)
	if err := b.BeginPriced("new", "old", 5, priceSnapshot(t, 1)); !errors.Is(err, ErrTaskPricingConflict) {
		t.Fatalf("upgrade: %v", err)
	}
	after, _ := os.ReadFile(b.path)
	if string(before) != string(after) {
		t.Fatal("conflict rewrote ledger")
	}
	if err := b.BeginPriced("priced", "new", 5, priceSnapshot(t, 1)); err != nil {
		t.Fatal(err)
	}
	if err := b.Begin("priced", "different", 5); !errors.Is(err, ErrTaskChanged) {
		t.Fatal("priced cell rebound without detach")
	}
}
func TestTaskPricingWireRejectsMissingNullUnknownAndDuplicates(t *testing.T) {
	valid := `{"v":1,"routes":[{"route":"anthropic","models":[{"id":"m","inputUSDPerMTok":0,"outputUSDPerMTok":1,"maxOutputTokens":10}]}]}`
	var p TaskPricing
	if err := json.Unmarshal([]byte(valid), &p); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"maxOutputTokens":10`, `"maxOutputTokens":10,"cacheReadUSDPerMTok":null`, 1),
		`null`, strings.Replace(valid, `"inputUSDPerMTok":0,`, "", 1), strings.Replace(valid, `"outputUSDPerMTok":1`, `"outputUSDPerMTok":null`, 1), strings.Replace(valid, `"maxOutputTokens":10`, `"maxOutputTokens":0`, 1), strings.Replace(valid, `"v":1`, `"v":1,"bindings":{}`, 1), strings.Replace(valid, `"id":"m"`, `"id":"m","surrogate":"fake"`, 1), strings.Replace(valid, `"v":1`, `"v":2`, 1),
	} {
		if err := json.Unmarshal([]byte(raw), &p); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	p = priceSnapshot(t, 1).Pricing
	p.Routes = append(p.Routes, p.Routes[0])
	if _, err := CanonicalTaskPricing(p); err == nil {
		t.Fatal("duplicate route")
	}
	p = priceSnapshot(t, 1).Pricing
	p.Routes[0].Models = append(p.Routes[0].Models, p.Routes[0].Models[0])
	if _, err := CanonicalTaskPricing(p); err == nil {
		t.Fatal("duplicate model")
	}
}
func TestPricedTaskLedgerFailsClosedAndLegacyStillOpens(t *testing.T) {
	c := &clock{time.Now()}
	path := filepath.Join(t.TempDir(), "spend.json")
	b := openBudget(t, path, c)
	if err := b.BeginPriced("a", "session", 5, priceSnapshot(t, 1)); err != nil {
		t.Fatal(err)
	}
	good, _ := os.ReadFile(path)
	for _, bad := range []string{
		strings.Replace(string(good), `"pricingMode":"snapshot"`, `"pricingMode":"snapshot","futurePolicy":true`, 1),
		strings.Replace(string(good), `"pricing":{`, `"pricingMissing":{`, 1),
		strings.Replace(string(good), `"bindings":{`, `"extra":1,"bindings":{`, 1),
		strings.Replace(string(good), strings.Repeat("a", 64), "invalid-binding", 1),
		strings.Replace(string(good), `"pricingMode":"snapshot"`, `"pricingMode":"legacy"`, 1),
		strings.Replace(string(good), `"initialLimitMicroUSD":5000000`, `"initialLimitMicroUSD":0`, 1),
		strings.Replace(string(good), `"v":2`, `"v":3`, 1),
		strings.Replace(string(good), `"v":2`, `"v":1`, 1),
		strings.Replace(string(good), `"pricingMode":"snapshot"`, `"pricingMode":"unknown"`, 1),
	} {
		if err := os.WriteFile(path, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenBudget(path, func() Limits { return DefaultLimits }, time.Now); err == nil {
			t.Fatalf("opened corrupt policy %s", bad)
		}
	}
	legacy := `{"v":1,"date":"2026-10-03","microUSD":1000000,"tasks":{"old":{"limitMicroUSD":5000000,"spentMicroUSD":1000000}}}`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	reopened := openBudget(t, path, c)
	if err := reopened.Begin("x", "old", 0); err != nil {
		t.Fatal(err)
	}
	if !reopened.IsLegacy("x") {
		t.Fatal("legacy account changed mode")
	}
}
func TestPricedTaskPersistenceFailureDoesNotPublish(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "ledger")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	b := openBudget(t, filepath.Join(dir, "spend.json"), &clock{time.Now()})
	if err := os.Rename(dir, dir+"-away"); err != nil {
		t.Fatal(err)
	}
	if err := b.BeginPriced("a", "session", 5, priceSnapshot(t, 1)); err == nil {
		t.Fatal("save succeeded unexpectedly")
	}
	if _, ok := b.Task("a"); ok {
		t.Fatal("failed save attached cell")
	}
	if _, ok := b.records["session"]; ok {
		t.Fatal("failed save published policy")
	}
}

func TestTaskPricingCanonicalRetryAndBounds(t *testing.T) {
	p := priceSnapshot(t, 1).Pricing
	p.Routes = append(p.Routes, TaskPricingRoute{Route: "second", Models: []Price{{Model: "z", Output: 2, MaxOutput: 100}, {Model: "a", Output: 1, MaxOutput: 50}}})
	bindings := map[string]string{"anthropic": strings.Repeat("a", 64), "second": strings.Repeat("b", 64)}
	want, err := NewTaskSnapshot(p, bindings)
	if err != nil {
		t.Fatal(err)
	}
	p.Routes[0], p.Routes[1] = p.Routes[1], p.Routes[0]
	p.Routes[0].Models[0], p.Routes[0].Models[1] = p.Routes[0].Models[1], p.Routes[0].Models[0]
	p.Routes[0].Models[0].Input = math.Copysign(0, -1)
	got, err := NewTaskSnapshot(p, bindings)
	if err != nil || !want.equal(got) {
		t.Fatalf("equivalent policy differs: %v", err)
	}
	for _, count := range []int{64, 65} {
		p := priceSnapshot(t, 1).Pricing
		p.Routes[0].Models = nil
		for i := range count {
			p.Routes[0].Models = append(p.Routes[0].Models, Price{Model: fmt.Sprintf("m%d", i), Input: 1, MaxOutput: 1})
		}
		_, err := CanonicalTaskPricing(p)
		if (err == nil) != (count == 64) {
			t.Fatalf("model count %d: %v", count, err)
		}
	}
	p = priceSnapshot(t, 1).Pricing
	for i := range 8 {
		p.Routes = append(p.Routes, TaskPricingRoute{Route: fmt.Sprintf("r%d", i), Models: p.Routes[0].Models})
	}
	if _, err := CanonicalTaskPricing(p); err == nil {
		t.Fatal("accepted 9 routes")
	}
}

func TestPricedTaskConcurrentInitializersHaveOneImmutableWinner(t *testing.T) {
	b := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), &clock{time.Now()})
	p1, p2 := priceSnapshot(t, 1), priceSnapshot(t, 2)
	start := make(chan struct{})
	done := make(chan error, 2)
	for i, p := range []*TaskSnapshot{p1, p2} {
		go func() { <-start; done <- b.BeginPriced(fmt.Sprintf("c%d", i), "session", 5, p) }()
	}
	close(start)
	var accepted, conflicts int
	for range 2 {
		err := <-done
		if err == nil {
			accepted++
		} else if errors.Is(err, ErrTaskPricingConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if accepted != 1 || conflicts != 1 {
		t.Fatalf("accepted=%d conflicts=%d", accepted, conflicts)
	}
	if len(b.tasks) != 1 {
		t.Fatal("conflicting initializer left an attachment")
	}
	reopened := openBudget(t, b.path, &clock{time.Now()})
	if err := reopened.BeginPriced("recovery", "session", 5, b.records["session"].pricing); err != nil {
		t.Fatal(err)
	}
}
