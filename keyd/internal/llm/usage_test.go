package llm

import (
	"io"
	"strings"
	"testing"
)

func meter(t *testing.T, contentType string, body string, chunk int) Usage {
	t.Helper()
	m := NewMeter(contentType)
	for len(body) > 0 {
		n := min(chunk, len(body))
		if _, err := io.WriteString(m, body[:n]); err != nil {
			t.Fatal(err)
		}
		body = body[n:]
	}
	return m.Usage()
}

func TestMeterReadsEachProvidersUsage(t *testing.T) {
	cases := []struct {
		name        string
		contentType string
		body        string
		want        Usage
	}{
		{
			"anthropic json", "application/json",
			`{"id":"msg_1","content":[{"type":"tool_use","input":{"usage":{"output_tokens":0}}}],"usage":{"input_tokens":1200,"output_tokens":80,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000}}`,
			Usage{Input: 1200, Output: 80, CacheWrite: 300, CacheRead: 4000, Reported: true},
		},
		{
			"anthropic sse", "text/event-stream",
			"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1370,\"output_tokens\":1}}}\n\n" +
				"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\n" +
				"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":142}}\n\n",
			Usage{Input: 1370, Output: 142, Reported: true},
		},
		{
			"openai chat sse", "text/event-stream; charset=utf-8",
			"data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}],\"usage\":null}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":50,\"completion_tokens\":7}}\n\ndata: [DONE]\n\n",
			Usage{Input: 50, Output: 7, Reported: true},
		},
		{
			"openai responses sse", "text/event-stream",
			"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"usage\":null}}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":900,\"output_tokens\":33}}}\n\n",
			Usage{Input: 900, Output: 33, Reported: true},
		},
		{
			"gemini sse", "text/event-stream",
			"data: {\"usageMetadata\":{\"promptTokenCount\":1222,\"candidatesTokenCount\":10}}\r\n\r\ndata: {\"usageMetadata\":{\"promptTokenCount\":1222,\"candidatesTokenCount\":27,\"thoughtsTokenCount\":40}}\r\n\r\n",
			Usage{Input: 1222, Output: 27, Reasoning: 40, Reported: true},
		},
		{
			"gemini cached", "application/json",
			`{"usageMetadata":{"promptTokenCount":5000,"cachedContentTokenCount":4000,"candidatesTokenCount":9}}`,
			Usage{Input: 1000, CacheRead: 4000, Output: 9, Reported: true},
		},
		{
			"openai chat cached and reasoning", "application/json",
			`{"usage":{"prompt_tokens":3000,"completion_tokens":500,"total_tokens":3500,"prompt_tokens_details":{"cached_tokens":2048},"completion_tokens_details":{"reasoning_tokens":320}}}`,
			Usage{Input: 952, CacheRead: 2048, Output: 180, Reasoning: 320, Reported: true},
		},
		{
			"openai responses cached", "text/event-stream",
			"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":900,\"input_tokens_details\":{\"cached_tokens\":512},\"output_tokens\":33}}}\n\n",
			Usage{Input: 388, CacheRead: 512, Output: 33, Reported: true},
		},
		{
			"reasoning counted apart from output", "application/json",
			`{"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":170,"completion_tokens_details":{"reasoning_tokens":50}}}`,
			Usage{Input: 100, Output: 20, Reasoning: 50, Reported: true},
		},
		{
			"moonshot cached", "application/json",
			`{"usage":{"prompt_tokens":800,"completion_tokens":10,"total_tokens":810,"cached_tokens":600}}`,
			Usage{Input: 200, CacheRead: 600, Output: 10, Reported: true},
		},
		{
			"more cached than read", "application/json",
			`{"usage":{"prompt_tokens":10,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":99}}}`,
			Usage{Input: 10, Output: 1, Reported: true},
		},
		{
			"gemini json array", "application/json",
			`[{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2}},{"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}]`,
			Usage{Input: 10, Output: 5, Reported: true},
		},
		{"no usage", "application/json", `{"data":[{"id":"m"}]}`, Usage{}},
		{"not json", "text/plain", "upstream error", Usage{}},
	}
	for _, c := range cases {
		for _, chunk := range []int{1, 7, 1 << 20} {
			if got := meter(t, c.contentType, c.body, chunk); got != c.want {
				t.Errorf("%s (chunks of %d): %+v, want %+v", c.name, chunk, got, c.want)
			}
		}
	}
}

func TestMeterSurvivesOversizedInput(t *testing.T) {
	big := "data: {\"pad\":\"" + strings.Repeat("x", 2<<20) + "\"}\n\ndata: {\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n"
	if got := meter(t, "text/event-stream", big, 64<<10); got != (Usage{Input: 3, Output: 4, Reported: true}) {
		t.Fatalf("after an oversized line: %+v", got)
	}
	if got := meter(t, "application/json", strings.Repeat(" ", maxJSONBody+1)+`{"usage":{"prompt_tokens":1}}`, 1<<20); got.Reported {
		t.Fatalf("a body over the cap was parsed: %+v", got)
	}
}

// The first-class bearer providers of Part 5a's amendment (P5a-R31) stream their usage in their
// own places: xAI's Responses API in response.completed, Mistral, DeepSeek and OpenRouter in the
// last chunk's usage, Groq only in the last chunk's x_groq. The numbers are the brain's fixtures'
// (cells/brain/src/testing/provider-streams.ts).
func TestMeterReadsTheFirstClassBearerProviders(t *testing.T) {
	last := func(extra string) string {
		return "data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\n" +
			"data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]," + extra + "}\n\n" +
			"data: [DONE]\n\n"
	}
	const usage = `{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280}`
	streams := map[string]string{
		"xai": "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"status\":\"in_progress\",\"output\":[]}}\n\n" +
			"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"item_id\":\"msg_1\",\"delta\":\"ok\"}\n\n" +
			"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1200,\"output_tokens\":80,\"total_tokens\":1280,\"output_tokens_details\":{\"reasoning_tokens\":30}}}}\n\n",
		"mistral":    last(`"usage":` + usage),
		"deepseek":   last(`"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280,"prompt_cache_hit_tokens":1000,"prompt_cache_miss_tokens":200}`),
		"groq":       last(`"x_groq":{"id":"req_1","usage":` + usage + `}`),
		"openrouter": last(`"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280,"cost":0.0042}`),
	}
	plain := Usage{Input: 1200, Output: 80, Reported: true}
	wants := map[string]Usage{
		"xai":        {Input: 1200, Output: 50, Reasoning: 30, Reported: true},
		"mistral":    plain,
		"deepseek":   {Input: 200, CacheRead: 1000, Output: 80, Reported: true},
		"groq":       plain,
		"openrouter": {Input: 1200, Output: 80, Reported: true, Billed: true, BilledCost: 4200},
	}
	for name, body := range streams {
		want := wants[name]
		for _, chunk := range []int{1, 7, 1 << 20} {
			if got := meter(t, "text/event-stream", body, chunk); got != want {
				t.Errorf("%s (chunks of %d): %+v, want %+v", name, chunk, got, want)
			}
		}
	}
	// Only a chunk's own x_groq counts, never one inside the answer.
	nested := "data: {\"choices\":[{\"delta\":{\"x_groq\":{\"usage\":{\"prompt_tokens\":1}}}}]}\n\n"
	if got := meter(t, "text/event-stream", nested, 1<<20); got.Reported {
		t.Fatalf("a nested x_groq was read as usage: %+v", got)
	}
}

func TestCostRoundsUpAndChargesCacheTokens(t *testing.T) {
	p := Price{Model: "claude-sonnet-5-5", Input: 3, Output: 15, CacheRead: 0.3}
	u := Usage{Input: 1000, Output: 100, CacheWrite: 10, CacheRead: 1000}
	// 1000*3 + 100*15 + 10*3 (cache write falls back to the input price) + 1000*0.3 micro-USD
	if got := p.Cost(u); got != 4830 {
		t.Fatalf("Cost = %d, want 4830", got)
	}
	if got := (Price{Input: 0.1}).Cost(Usage{Input: 1}); got != 1 {
		t.Fatalf("a fraction of a micro-dollar rounds to %d, want 1", got)
	}
}

func TestReasoningCostsItsOwnPriceOrTheOutputPrice(t *testing.T) {
	u := Usage{Input: 1000, Output: 100, Reasoning: 400}
	// 1000*1 + 100*4 + 400*4 micro-USD: reasoning falls back to the output price.
	if got := (Price{Input: 1, Output: 4}).Cost(u); got != 3000 {
		t.Fatalf("Cost = %d, want 3000", got)
	}
	// 1000*1 + 100*4 + 400*10
	p := Price{Input: 1, Output: 4, Reasoning: 10}
	if got := p.Cost(u); got != 5400 {
		t.Fatalf("Cost = %d, want 5400", got)
	}
	if got := p.Ceiling(0, 100); got != 1000 {
		t.Fatalf("a dearer reasoning price must bound the hold: ceiling %d, want 1000", got)
	}
}

func TestCeilingIsTheMostARequestCanCost(t *testing.T) {
	// 1,000 input tokens at the cache-write price, plus 500 output tokens.
	if got := (Price{Input: 3, Output: 15, CacheWrite: 3.75}).Ceiling(1000, 500); got != 1000*3.75+500*15 {
		t.Fatalf("Ceiling = %d", got)
	}
	if got := (Price{Input: 3}).Ceiling(1000, 0); got != 3000 {
		t.Fatalf("Ceiling without output = %d", got)
	}
}

func TestEstimateIsConservative(t *testing.T) {
	if got := Estimate(3000, 301); got != (Usage{Input: 1000, Output: 101}) {
		t.Fatalf("Estimate = %+v", got)
	}
}

func TestTheCeilingCoversTheDearerCacheReadPrice(t *testing.T) {
	p := Price{Input: 1, CacheWrite: 4, CacheRead: 7, Output: 2}
	if got := p.Ceiling(3, 4); got != 29 {
		t.Fatalf("cached input can exceed the hold: ceiling %d, want 29", got)
	}
}
