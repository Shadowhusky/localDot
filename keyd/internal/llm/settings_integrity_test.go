package llm

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"testing"
)

func TestASettingsWriteFailureLeavesTheLivePolicyUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing-parent", "settings.json")
	s, err := OpenSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SetLimits(Limits{PerTaskUSD: 6, PerDayUSD: 30}); err == nil {
		t.Fatal("a missing parent accepted the limits")
	}
	if got := s.Limits(); got != DefaultLimits {
		t.Fatalf("failed write changed live limits: %+v", got)
	}
	if err := s.SetModels("openai", []Price{{Model: "priced-model", Input: 2, Output: 8, MaxOutput: 1000}}); err == nil {
		t.Fatal("a missing parent accepted model prices")
	}
	if _, ok := s.Price("openai", "priced-model"); ok {
		t.Fatal("failed write added a live model/price")
	}
}

func TestLoadedSettingsAreValidatedBeforeTheyBecomeLive(t *testing.T) {
	for _, data := range []settingsFile{
		{V: 3, Limits: DefaultLimits},
		{V: 1, Limits: Limits{PerTaskUSD: -1, PerDayUSD: 20}},
		{V: 2, Limits: Limits{PerTaskUSD: 30, PerDayUSD: 20}},
		{V: 1, Limits: DefaultLimits, Models: map[string][]Price{"openai": {{Model: "m", Input: -1}}}},
		{V: 1, Limits: DefaultLimits, Models: map[string][]Price{"openai": {{Model: "m", Output: 2}}}},
		{V: 1, Limits: DefaultLimits, Models: map[string][]Price{"openai": {{Model: "m", Input: 1}, {Model: "m", Input: 10}}}},
	} {
		path := filepath.Join(t.TempDir(), "settings.json")
		raw, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenSettings(path); err == nil {
			t.Fatalf("invalid loaded settings became live: %s", raw)
		}
	}
}

func TestNonfiniteLimitsAndPricesNeverBecomeLive(t *testing.T) {
	s, err := OpenSettings(filepath.Join(t.TempDir(), "settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		if err := s.SetLimits(Limits{PerTaskUSD: f, PerDayUSD: 20}); err == nil {
			t.Fatalf("nonfinite task limit %v accepted", f)
		}
		if got := s.Limits(); got != DefaultLimits {
			t.Fatalf("nonfinite task limit changed live policy: %+v", got)
		}
		for field := range 4 {
			price := Price{Model: "m", Input: 1, Output: 2, MaxOutput: 1000}
			fields := []*float64{&price.Input, &price.Output, &price.CacheRead, &price.CacheWrite}
			*fields[field] = f
			if err := s.SetModels("openai", []Price{price}); err == nil {
				t.Fatalf("nonfinite price field %d accepted: %v", field, f)
			}
			if _, ok := s.Price("openai", "m"); ok {
				t.Fatal("nonfinite price remained live after its save failed")
			}
		}
	}
}

func TestSpendingLimitsAreTheUsersToSet(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s, err := OpenSettings(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := s.Limits(); got != (Limits{}) {
		t.Fatalf("a new install has limits %+v, want none", got)
	}
	for _, ok := range []Limits{{}, {PerTaskUSD: 2}, {PerDayUSD: 8}, {PerTaskUSD: 2, PerDayUSD: 8}} {
		if err := s.SetLimits(ok); err != nil {
			t.Errorf("SetLimits(%+v): %v", ok, err)
		}
	}
	for _, bad := range []Limits{{PerTaskUSD: -1}, {PerDayUSD: 10_001}, {PerTaskUSD: 9, PerDayUSD: 8}, {PerTaskUSD: 1e-9}} {
		if err := s.SetLimits(bad); err == nil {
			t.Errorf("SetLimits(%+v) accepted", bad)
		}
	}
}

func TestTheLimitsKeydOnceWroteForEveryoneAreDropped(t *testing.T) {
	for _, c := range []struct {
		saved, want Limits
	}{
		{formerDefaults, Limits{}},
		{Limits{PerTaskUSD: 3, PerDayUSD: 20}, Limits{PerTaskUSD: 3, PerDayUSD: 20}},
	} {
		path := filepath.Join(t.TempDir(), "settings.json")
		raw, err := json.Marshal(settingsFile{V: 1, Limits: c.saved, Models: map[string][]Price{}})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0o600); err != nil {
			t.Fatal(err)
		}
		s, err := OpenSettings(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := s.Limits(); got != c.want {
			t.Errorf("saved %+v opened as %+v, want %+v", c.saved, got, c.want)
		}
	}
}
