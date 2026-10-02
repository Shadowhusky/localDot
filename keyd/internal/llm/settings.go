package llm

import (
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"os"
	"regexp"
	"slices"
	"sync"
)

type Limits struct {
	PerTaskUSD float64 `json:"perTaskUSD"`
	PerDayUSD  float64 `json:"perDayUSD"`
}

// DefaultLimits are the spec's: $5 per task and $20 per day.
var DefaultLimits = Limits{PerTaskUSD: 5, PerDayUSD: 20}

var modelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$`)

// Bounds that keep every ceiling well inside an int64 of micro-dollars.
const (
	maxPrice     = 10_000
	maxOutputCap = 100_000_000
)

type settingsFile struct {
	V      int                `json:"v"`
	Limits Limits             `json:"limits"`
	Models map[string][]Price `json:"models"`
}

// Settings holds the editable budget limits and, per gateway route, the models the user picked
// with their prices. A route with no models refuses every request.
type Settings struct {
	mu   sync.Mutex
	path string
	data settingsFile
}

func OpenSettings(path string) (*Settings, error) {
	s := &Settings{path: path, data: settingsFile{V: 1, Limits: DefaultLimits, Models: map[string][]Price{}}}
	raw, err := os.ReadFile(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return s, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(raw, &s.data); err != nil {
		return nil, fmt.Errorf("settings %s: %w", path, err)
	}
	if s.data.Models == nil {
		s.data.Models = map[string][]Price{}
	}
	if s.data.V != 1 {
		return nil, errors.New("llm: unsupported settings version")
	}
	if err := validateLimits(s.data.Limits); err != nil {
		return nil, err
	}
	for _, models := range s.data.Models {
		if err := validateModels(models); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Settings) Limits() Limits {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.data.Limits
}

func validateLimits(l Limits) error {
	if math.IsNaN(l.PerTaskUSD) || math.IsInf(l.PerTaskUSD, 0) || math.IsNaN(l.PerDayUSD) || math.IsInf(l.PerDayUSD, 0) || l.PerTaskUSD <= 0 || l.PerDayUSD <= 0 || l.PerTaskUSD > l.PerDayUSD || l.PerDayUSD > 10_000 || micros(l.PerTaskUSD) < 1 {
		return errors.New("llm: limits must be finite and positive, per task no more than per day, per day at most $10,000")
	}
	return nil
}

func (s *Settings) SetLimits(l Limits) error {
	if err := validateLimits(l); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	next.Limits = l
	return s.saveLocked(next)
}

func (s *Settings) Models(route string) []Price {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.data.Models[route])
}

func validateModels(models []Price) error {
	if len(models) > 64 {
		return errors.New("llm: at most 64 models per route")
	}
	seen := make(map[string]bool, len(models))
	for _, m := range models {
		if seen[m.Model] {
			return fmt.Errorf("llm: duplicate model id %q", m.Model)
		}
		seen[m.Model] = true
		for _, price := range []float64{m.Input, m.Output, m.CacheRead, m.CacheWrite} {
			if math.IsNaN(price) || math.IsInf(price, 0) {
				return errors.New("llm: model prices must be finite")
			}
		}
		if !modelID.MatchString(m.Model) {
			return fmt.Errorf("llm: model id %q", m.Model)
		}
		if min(m.Input, m.Output, m.CacheRead, m.CacheWrite) < 0 || max(m.Input, m.Output, m.CacheRead, m.CacheWrite) > maxPrice {
			return fmt.Errorf("llm: model %s: prices must be $0 to $%d per million tokens", m.Model, maxPrice)
		}
		// The gateway bounds every request's output cap by the model's maximum.
		if m.MaxOutput < 0 || m.MaxOutput > maxOutputCap || m.Output > 0 && m.MaxOutput == 0 {
			return fmt.Errorf("llm: model %s: maxOutputTokens must be 1 to %d when output has a price", m.Model, maxOutputCap)
		}
	}
	return nil
}

func (s *Settings) SetModels(route string, models []Price) error {
	if err := validateModels(models); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	next.Models = maps.Clone(s.data.Models)
	next.Models[route] = slices.Clone(models)
	return s.saveLocked(next)
}

func (s *Settings) Price(route, model string) (Price, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.data.Models[route] {
		if p.Model == model {
			return p, true
		}
	}
	return Price{}, false
}

func (s *Settings) saveLocked(next settingsFile) error {
	raw, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(s.path, raw); err != nil {
		return err
	}
	s.data = next
	return nil
}
