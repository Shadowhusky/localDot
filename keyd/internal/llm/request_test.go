package llm

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestModelFromJSON(t *testing.T) {
	cases := map[string]string{
		`{"model":"claude-sonnet-5-5","messages":[]}`:             "claude-sonnet-5-5",
		`{"messages":[{"model":"nested"}],"model":"gpt-6.1-sol"}`: "gpt-6.1-sol",
		`{"input":"x"}`: "",
		` {"stream":true , "model" : "qwen/qwen3.8-27b" }`: "qwen/qwen3.8-27b",
	}
	for body, want := range cases {
		got, err := ModelFromJSON([]byte(body))
		if err != nil || got != want {
			t.Errorf("%s: %q, %v", body, got, err)
		}
	}
	if _, err := ModelFromJSON([]byte(`{"model":"cheap","model":"expensive"}`)); !errors.Is(err, ErrDuplicateModel) {
		t.Errorf("duplicate model: %v", err)
	}
	// Go's encoding/json, which Ollama and other Go servers use, reads the last case-insensitive match.
	if _, err := ModelFromJSON([]byte(`{"model":"cheap","Model":"expensive"}`)); !errors.Is(err, ErrDuplicateModel) {
		t.Errorf("a model named in two letter cases: %v", err)
	}
	if _, err := ModelFromJSON([]byte(`{"MODEL":"expensive"}`)); err == nil {
		t.Error("a model named in capitals was accepted")
	}
	for _, body := range []string{`{"model":5}`, `[1,2]`, `not json`, `{"model":"x"`} {
		if _, err := ModelFromJSON([]byte(body)); err == nil {
			t.Errorf("%s: accepted", body)
		}
	}
}

func TestReadRequest(t *testing.T) {
	caps := []struct {
		api, body string
		cap       int64
		has       bool
	}{
		{BodyAnthropic, `{"model":"m","max_tokens":64}`, 64, true},
		{BodyAnthropic, `{"model":"m","max_tokens":0}`, 0, true},
		{BodyChat, `{"max_completion_tokens":100,"max_tokens":50}`, 50, true},
		{BodyChat, `{"max_tokens":10,"MAX_TOKENS":100000}`, 10, true},
		{BodyChat, `{"max_output_tokens":2048}`, 2048, true},
		{BodyGemini, `{"generationConfig":{"maxOutputTokens":512}}`, 512, true},
		{BodyGemini, `{"generation_config":{"max_output_tokens":256}}`, 256, true},
		{BodyChat, `{"max_completion_tokens":null}`, 0, false},
		{BodyGemini, `{"generationConfig":{"maxOutputTokens":null}}`, 0, false},
		{BodyGemini, `{"generationConfig":{"maxOutputTokens":0}}`, 0, false},
		{BodyChat, `{"max_tokens":0}`, 0, false},
		{BodyChat, `{"max_tokens":"64"}`, 0, false},
		{BodyChat, `{"max_tokens":-1}`, 0, false},
		{BodyChat, `{"max_tokens":64.5}`, 0, false},
		{BodyChat, `{"max_tokens":1e12}`, 0, false},
		{BodyGemini, `{"generationConfig":null}`, 0, false},
		{BodyChat, `{"messages":[]}`, 0, false},
	}
	for _, c := range caps {
		req, err := ReadRequest(c.api, "m", []byte(c.body))
		if err != nil || req.Cap != c.cap || req.HasCap != c.has {
			t.Errorf("%s %s: %+v %v; want cap %d, %v", c.api, c.body, req, err, c.cap, c.has)
		}
	}
	for body, field := range map[string]string{
		`{"model":"m","n":128}`:                       "n",
		`{"model":"m","N":2}`:                         "N",
		`{"model":"m","n":"2"}`:                       "n",
		`{"model":"m","n":0}`:                         "n",
		`{"model":"m","best_of":20}`:                  "best_of",
		`{"generationConfig":{"candidateCount":8}}`:   "candidateCount",
		`{"generation_config":{"candidate_count":2}}`: "candidate_count",
	} {
		var many *ChoiceError
		if _, err := ReadRequest(BodyGemini, "m", []byte(body)); !errors.As(err, &many) || many.Field != field {
			t.Errorf("%s: %v, want a refusal naming %s", body, err, field)
		}
	}
	for _, body := range []string{`{"model":"m","n":1,"best_of":null}`, `{"generationConfig":{"candidateCount":1}}`} {
		if _, err := ReadRequest(BodyGemini, "m", []byte(body)); err != nil {
			t.Errorf("%s: %v", body, err)
		}
	}
	for _, body := range []string{`{"generationConfig":{},"generation_config":{}}`, `not json`, `[1]`} {
		if _, err := ReadRequest(BodyGemini, "m", []byte(body)); err == nil {
			t.Errorf("%s: accepted", body)
		}
	}
	// The completions API answers each prompt of a list, every answer under the one cap.
	for body, field := range map[string]string{
		`{"model":"m","prompt":["x","y"],"max_tokens":1500}`: "prompt",
		`{"model":"m","prompt":[[1],[2],[3]]}`:               "prompt",
		`{"model":"m","Prompt":[1,2]}`:                       "Prompt",
	} {
		var many *ChoiceError
		if _, err := ReadRequest(BodyCompletions, "m", []byte(body)); !errors.As(err, &many) || many.Field != field {
			t.Errorf("%s: %v, want a refusal naming %s", body, err, field)
		}
	}
	for _, body := range []string{`{"model":"m","prompt":"x"}`, `{"model":"m","prompt":["x"]}`, `{"model":"m","prompt":[[1,2,3]]}`} {
		if _, err := ReadRequest(BodyCompletions, "m", []byte(body)); err != nil {
			t.Errorf("%s: %v", body, err)
		}
	}
	if _, err := ReadRequest(BodyChat, "m", []byte(`{"model":"m","prompt":["x","y"]}`)); err != nil {
		t.Errorf("a prompt list outside completions: %v", err)
	}
	// OpenRouter's fallback models can answer in place of the allowlisted one, at their own price
	// (P5a-R31).
	for body, field := range map[string]string{
		`{"model":"m","models":["m","pricier"],"messages":[]}`: "models",
		`{"model":"m","Models":["pricier"]}`:                   "Models",
		`{"model":"m","models":[]}`:                            "models",
	} {
		var many *ChoiceError
		if _, err := ReadRequest(BodyChat, "m", []byte(body)); !errors.As(err, &many) || many.Field != field {
			t.Errorf("%s: %v, want a refusal naming %s", body, err, field)
		}
	}
	if _, err := ReadRequest(BodyChat, "m", []byte(`{"model":"m","models":null}`)); err != nil {
		t.Errorf("a null models list: %v", err)
	}
	if req, _ := ReadRequest(BodyChat, "m", []byte(`{"messages":"`+strings.Repeat("x", 2985)+`"}`)); req.Input != 1000 {
		t.Errorf("3,000 bytes of text: %d tokens, want 1,000", req.Input)
	}
}

// Invalid UTF-8 in an image's base64 decodes to U+FFFD, three bytes for each byte of the body, so
// the image can seem longer than the body it came in. The request still holds at least its output,
// and lends no room to the requests beside it.
func TestAMalformedImageCannotMakeAHoldNegative(t *testing.T) {
	var b bytes.Buffer
	b.WriteString(`{"model":"m","max_tokens":300000,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"`)
	b.Write(bytes.Repeat([]byte{0xff}, 3<<20))
	b.WriteString(`"}}]}]}`)
	req, err := ReadRequest(BodyAnthropic, "m", b.Bytes())
	if err != nil || req.Input != anthropicMaxImage {
		t.Fatalf("input %d tokens, %v; want %d, an image keyd cannot size", req.Input, err, anthropicMaxImage)
	}
	c := &clock{time.Date(2026, 10, 1, 12, 0, 0, 0, time.Local)}
	budget := openBudget(t, filepath.Join(t.TempDir(), "spend.json"), c)
	budget.Begin("c1", "t1", 0)
	price := Price{Input: 3, Output: 15, MaxOutput: 300_000}
	h, err := budget.Reserve(context.Background(), "c1", Ask{Fixed: price.Ceiling(req.Input, 0), PerToken: price.Output, Tokens: req.Cap})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Release()
	if !waits(budget, "c1", Ask{Fixed: 60, PerToken: 15, Tokens: 300_000}) {
		t.Fatalf("a $4.50 request ran beside one holding $%.2f", float64(h.Amount())/1e6)
	}
}

func TestWithCap(t *testing.T) {
	cases := []struct{ field, body, want string }{
		{"max_tokens", `{"model":"m","max_tokens":null,"max_output_tokens":1,"messages":[]}`, `{"model":"m","messages":[],"max_tokens":4096}`},
		{"max_completion_tokens", `{"model":"m", "MAX_TOKENS":9,"n":1}`, `{"model":"m","n":1,"max_completion_tokens":4096}`},
		{"generationConfig.maxOutputTokens", `{"contents":[]}`, `{"contents":[],"generationConfig":{"maxOutputTokens":4096}}`},
		{"generationConfig.maxOutputTokens", `{"contents":[],"generation_config":{"max_output_tokens":9,"temperature":1}}`, `{"contents":[],"generation_config":{"temperature":1,"maxOutputTokens":4096}}`},
		{"generationConfig.maxOutputTokens", `{"generationConfig":null,"max_tokens":3}`, `{"generationConfig":{"maxOutputTokens":4096}}`},
		{"max_tokens", `{"model":"m","messages":[{"role":"user","content":"a <b> & c"}]}`, `{"model":"m","messages":[{"role":"user","content":"a <b> & c"}],"max_tokens":4096}`},
	}
	for _, c := range cases {
		got, err := WithCap(c.field, []byte(c.body), 4096)
		if err != nil || string(got) != c.want {
			t.Errorf("%s in %s:\n got %s %v\nwant %s", c.field, c.body, got, err, c.want)
		}
	}
}

func TestRequestReadersRequireOneCompleteJSONDocument(t *testing.T) {
	for _, body := range []string{
		`{"model":"allowed"}{"model":"other"}`,
		`{"model":"allowed"} true`,
		`{"model":"allowed"} trailing`,
	} {
		if _, err := ModelFromJSON([]byte(body)); err == nil {
			t.Errorf("model reader accepted trailing data: %s", body)
		}
		if _, err := ReadRequest(BodyChat, "allowed", []byte(body)); err == nil {
			t.Errorf("cost reader accepted trailing data: %s", body)
		}
		if _, err := WithCap("max_tokens", []byte(body), 10); err == nil {
			t.Errorf("cap writer silently discarded trailing data: %s", body)
		}
	}
	if _, err := ReadRequest(BodyChat, "allowed", []byte("{\"model\":\"allowed\"} \n\t")); err != nil {
		t.Fatalf("valid trailing whitespace: %v", err)
	}
}
