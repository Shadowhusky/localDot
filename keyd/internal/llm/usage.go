// Package llm holds the LLM gateway's bookkeeping: the token usage each provider reports, what it
// costs, the per-task and per-day budgets, and the model allowlist with its prices.
package llm

import (
	"bytes"
	"encoding/json"
	"math"
	"strings"
)

const (
	maxSSELine  = 1 << 20
	maxJSONBody = 16 << 20
)

type Usage struct {
	Input      int64
	Output     int64
	CacheWrite int64
	CacheRead  int64
	Reported   bool
}

// Meter watches a response body go by and keeps the last usage the provider reported. It reads
// usage only where providers put it, so a tool call's arguments can never pose as usage.
type Meter struct {
	sse   bool
	buf   []byte
	over  bool
	usage Usage
}

func NewMeter(contentType string) *Meter {
	return &Meter{sse: strings.HasPrefix(strings.ToLower(contentType), "text/event-stream")}
}

func (m *Meter) Write(p []byte) (int, error) {
	if !m.sse {
		if !m.over && len(m.buf)+len(p) <= maxJSONBody {
			m.buf = append(m.buf, p...)
		} else {
			m.over, m.buf = true, nil
		}
		return len(p), nil
	}
	for rest := p; len(rest) > 0; {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			m.appendLine(rest)
			break
		}
		m.appendLine(rest[:i])
		if !m.over {
			m.line(m.buf)
		}
		m.buf, m.over = m.buf[:0], false
		rest = rest[i+1:]
	}
	return len(p), nil
}

func (m *Meter) appendLine(b []byte) {
	if m.over || len(m.buf)+len(b) > maxSSELine {
		m.over, m.buf = true, m.buf[:0]
		return
	}
	m.buf = append(m.buf, b...)
}

func (m *Meter) line(l []byte) {
	payload, ok := bytes.CutPrefix(bytes.TrimRight(l, "\r"), []byte("data:"))
	if !ok {
		return
	}
	m.parse(bytes.TrimSpace(payload))
}

// Usage returns what was reported; Reported is false when the provider reported nothing.
func (m *Meter) Usage() Usage {
	if !m.sse && !m.over && len(m.buf) > 0 {
		m.parse(m.buf)
		m.buf = nil
	}
	if m.sse && !m.over && len(m.buf) > 0 {
		m.line(m.buf)
		m.buf = m.buf[:0]
	}
	return m.usage
}

func (m *Meter) parse(data []byte) {
	var v any
	if json.Unmarshal(data, &v) != nil {
		return
	}
	values := []any{v}
	if arr, ok := v.([]any); ok {
		values = arr
	}
	for _, item := range values {
		obj, ok := item.(map[string]any)
		if !ok {
			continue
		}
		m.take(obj["usage"])
		m.take(field(obj, "message", "usage"))
		m.take(field(obj, "response", "usage"))
		// Groq's streams report usage only here, in the last chunk (P5a-R31).
		m.take(field(obj, "x_groq", "usage"))
		if u, ok := obj["usageMetadata"].(map[string]any); ok {
			m.set(&m.usage.Input, u["promptTokenCount"])
			cand, okC := number(u["candidatesTokenCount"])
			thoughts, okT := number(u["thoughtsTokenCount"])
			if okC || okT {
				m.usage.Output, m.usage.Reported = cand+thoughts, true
			}
		}
	}
}

func (m *Meter) take(v any) {
	u, ok := v.(map[string]any)
	if !ok {
		return
	}
	m.set(&m.usage.Input, first(u["input_tokens"], u["prompt_tokens"]))
	m.set(&m.usage.Output, first(u["output_tokens"], u["completion_tokens"]))
	m.set(&m.usage.CacheWrite, u["cache_creation_input_tokens"])
	m.set(&m.usage.CacheRead, u["cache_read_input_tokens"])
}

func (m *Meter) set(dst *int64, v any) {
	if n, ok := number(v); ok {
		*dst, m.usage.Reported = n, true
	}
}

func field(obj map[string]any, keys ...string) any {
	var cur any = obj
	for _, k := range keys {
		next, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = next[k]
	}
	return cur
}

func first(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

func number(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || f < 0 || f > 1e12 {
		return 0, false
	}
	return int64(f), true
}

// Price is a model's list price in US dollars per million tokens, which is micro-dollars per
// token, and the most output tokens one request to it may ask for.
type Price struct {
	Model      string  `json:"id"`
	Input      float64 `json:"inputUSDPerMTok"`
	Output     float64 `json:"outputUSDPerMTok"`
	CacheRead  float64 `json:"cacheReadUSDPerMTok,omitempty"`
	CacheWrite float64 `json:"cacheWriteUSDPerMTok,omitempty"`
	MaxOutput  int64   `json:"maxOutputTokens,omitempty"`
}

// Cost in micro-dollars, rounded up. Cache tokens without their own price cost the input price.
func (p Price) Cost(u Usage) int64 {
	orInput := func(v float64) float64 {
		if v == 0 {
			return p.Input
		}
		return v
	}
	total := float64(u.Input)*p.Input + float64(u.Output)*p.Output +
		float64(u.CacheWrite)*orInput(p.CacheWrite) + float64(u.CacheRead)*orInput(p.CacheRead)
	return int64(math.Ceil(total))
}

// Ceiling is the most input and output tokens can cost: the input at the highest of the ordinary, cache-read and
// cache-write prices, the output at the output price.
func (p Price) Ceiling(input, output int64) int64 {
	return int64(math.Ceil(float64(input)*max(p.Input, p.CacheWrite, p.CacheRead) + float64(output)*p.Output))
}

// Estimate stands in when a provider reports no usage: about three bytes a token, rounded up,
// which overcharges rather than under.
func Estimate(requestBytes, responseBytes int64) Usage {
	return Usage{Input: (requestBytes + 2) / 3, Output: (responseBytes + 2) / 3}
}
