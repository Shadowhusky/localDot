package llm

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"strings"
)

// The most one image can cost each provider, in tokens, by its documented rule (P4a-R27). An
// image keyd cannot size, given by URL or file id or in a format other than PNG and JPEG, costs
// that much.
const (
	anthropicMaxImage = 4_784
	openAIMaxImage    = 73_800
	geminiMaxImage    = 2_240
	// Mistral's rule for a 2048-pixel square, more than any Mistral model's largest side: each
	// scales a larger image down first (Pixtral to 1024 pixels a side).
	mistralMaxImage = 128*128 + 128 + 1
	// A header is read from at most this much base64: 192 KB, past every PNG header and nearly
	// every JPEG's metadata.
	maxImageHead = 1 << 18
)

// imagesIn finds the images in a body where api carries them, and returns how many bytes of the
// body their base64 fills and how many tokens the provider bills for them. Images anywhere else
// are the provider's text, and stay in the body's text.
func imagesIn(api, model string, body []byte) (data, tokens int64) {
	var rule func(w, h int) int64
	var unread int64
	switch api {
	case BodyAnthropic:
		rule, unread = anthropicImage, anthropicMaxImage
	case BodyGemini:
		rule, unread = geminiImage, geminiMaxImage
	case BodyChat, BodyResponses:
		rule, unread = openAIImage, openAIMaxImage
		if strings.Contains(model, "4o-mini") {
			rule = gpt4oMiniImage
		}
	case BodyMistral:
		rule, unread = mistralImage, mistralMaxImage
	case BodyOpenRouter:
		rule, unread = largestImage, openAIMaxImage
		if strings.Contains(model, "4o-mini") {
			rule = gpt4oMiniImage
		}
	default:
		return 0, 0
	}
	var doc map[string]any
	if json.Unmarshal(body, &doc) != nil {
		return 0, 0
	}
	count := func(b64 string, inline bool) {
		w, h, ok := 0, 0, false
		if inline {
			data += int64(len(b64))
			w, h, ok = dimensions(b64)
		}
		if ok {
			tokens += rule(w, h)
		} else {
			tokens += unread
		}
	}
	switch api {
	case BodyAnthropic:
		anthropicImages(doc, count)
	case BodyChat, BodyMistral, BodyOpenRouter:
		chatImages(doc, count)
	case BodyResponses:
		responsesImages(doc, count)
	case BodyGemini:
		geminiImages(doc, count)
	}
	return data, tokens
}

// Anthropic: image blocks in a message's content, and in a tool result's.
func anthropicImages(doc map[string]any, count func(string, bool)) {
	block := func(b map[string]any) {
		src := object(b["source"])
		data, ok := src["data"].(string)
		count(data, ok && src["type"] == "base64")
	}
	for _, m := range list(doc["messages"]) {
		for _, c := range list(object(m)["content"]) {
			switch b := object(c); b["type"] {
			case "image":
				block(b)
			case "tool_result":
				for _, inner := range list(b["content"]) {
					if ib := object(inner); ib["type"] == "image" {
						block(ib)
					}
				}
			}
		}
	}
}

// OpenAI's chat completions: image_url parts of a message's content.
func chatImages(doc map[string]any, count func(string, bool)) {
	for _, m := range list(doc["messages"]) {
		for _, c := range list(object(m)["content"]) {
			p := object(c)
			if p["type"] != "image_url" {
				continue
			}
			u, _ := object(p["image_url"])["url"].(string)
			if s, ok := p["image_url"].(string); ok {
				u = s
			}
			count(dataURL(u))
		}
	}
}

// OpenAI's Responses: input_image parts of an item's content and of a function call's output, and
// a computer call's screenshot.
func responsesImages(doc map[string]any, count func(string, bool)) {
	image := func(p map[string]any) {
		u, _ := p["image_url"].(string)
		count(dataURL(u))
	}
	for _, item := range list(doc["input"]) {
		it := object(item)
		for _, c := range list(it["content"]) {
			if p := object(c); p["type"] == "input_image" {
				image(p)
			}
		}
		switch it["type"] {
		case "computer_call_output":
			image(object(it["output"]))
		case "function_call_output":
			for _, c := range list(it["output"]) {
				if p := object(c); p["type"] == "input_image" {
					image(p)
				}
			}
		}
	}
}

// Gemini: a part's inline or file data of an image type, and a function response's parts.
func geminiImages(doc map[string]any, count func(string, bool)) {
	var parts func(ps []any)
	parts = func(ps []any) {
		for _, p := range ps {
			part := object(p)
			for _, key := range []string{"inlineData", "inline_data"} {
				if d := object(part[key]); isImage(d) {
					data, ok := d["data"].(string)
					count(data, ok)
				}
			}
			for _, key := range []string{"fileData", "file_data"} {
				if isImage(object(part[key])) {
					count("", false)
				}
			}
			for _, key := range []string{"functionResponse", "function_response"} {
				parts(list(object(part[key])["parts"]))
			}
		}
	}
	for _, c := range list(doc["contents"]) {
		parts(list(object(c)["parts"]))
	}
}

func isImage(d map[string]any) bool {
	mime, _ := d["mimeType"].(string)
	if mime == "" {
		mime, _ = d["mime_type"].(string)
	}
	return strings.HasPrefix(strings.ToLower(mime), "image/")
}

// dataURL returns the base64 of a data: URL, and false for any other URL.
func dataURL(u string) (string, bool) {
	rest, ok := strings.CutPrefix(u, "data:")
	meta, b64, found := strings.Cut(rest, ",")
	if !ok || !found || !strings.HasSuffix(strings.ToLower(meta), ";base64") {
		return "", false
	}
	return b64, true
}

// dimensions reads an image's size from the PNG or JPEG header at the start of its base64.
func dimensions(b64 string) (int, int, bool) {
	head := strings.TrimRight(b64[:min(len(b64), maxImageHead)], "=")
	enc := base64.RawStdEncoding
	if strings.ContainsAny(head, "-_") {
		enc = base64.RawURLEncoding
	}
	raw, _ := enc.DecodeString(head) // what decodes before an error still holds the header
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 {
		return 0, 0, false
	}
	return cfg.Width, cfg.Height, true
}

// Anthropic: a token per 28-pixel patch; an image past the model's budget, 1,568 patches or 4,784
// on high-resolution models, is first scaled down to fit it.
func anthropicImage(w, h int) int64 {
	return min(ceilDiv(w, 28)*ceilDiv(h, 28), anthropicMaxImage)
}

// OpenAI bills by one of two rules, model by model; keyd takes the larger. Patches: 32-pixel
// patches, at most 30,000 (the API refuses more), times the largest multiplier, 2.46. Tiles: 85
// tokens and 170 per 512-pixel tile, once the image fits 2048 pixels square with its short side
// at most 768.
func openAIImage(w, h int) int64 {
	patches := min(ceilDiv(w, 32)*ceilDiv(h, 32), 30_000)
	return max((patches*246+99)/100, 85+170*openAITiles(w, h))
}

// Mistral (its "Vision" documentation): a token per 16-pixel patch of the image as sent, a break
// token after each row of patches, and an end token; a 1280x800 screenshot is 4,051 tokens. Models
// whose encoder merges patches (14 pixels, 2x2) bill fewer, and every model scales an image past
// its largest side down first, so this, unscaled and capped at mistralMaxImage, is at least what
// any Mistral model bills (Part 5a's amendment, P5a-R31).
func mistralImage(w, h int) int64 {
	return min(ceilDiv(w, 16)*ceilDiv(h, 16)+ceilDiv(h, 16)+1, mistralMaxImage)
}

// largestImage is the most any rule keyd knows bills, for a router that serves every vendor's
// models (OpenRouter).
func largestImage(w, h int) int64 {
	return max(openAIImage(w, h), mistralImage(w, h), anthropicImage(w, h), geminiImage(w, h))
}

// gpt-4o-mini bills 2,833 tokens and 5,667 per tile.
func gpt4oMiniImage(w, h int) int64 {
	return 2_833 + 5_667*openAITiles(w, h)
}

func openAITiles(w, h int) int64 {
	fw, fh := float64(w), float64(h)
	if s := 2048 / max(fw, fh); s < 1 {
		fw, fh = fw*s, fh*s
	}
	if s := 768 / min(fw, fh); s < 1 {
		fw, fh = fw*s, fh*s
	}
	return int64(math.Ceil(fw/512) * math.Ceil(fh/512))
}

// Gemini 3 bills an image at most 2,240 tokens, at its ultra-high media resolution. Earlier
// models bill 258 tokens for an image within 384 pixels both ways, else 258 per crop of
// ⌊min(w, h)/1.5⌋ pixels square.
func geminiImage(w, h int) int64 {
	tiles := int64(1)
	if w > 384 || h > 384 {
		unit := max(min(w, h)*2/3, 1)
		tiles = ceilDiv(w, unit) * ceilDiv(h, unit)
	}
	return max(geminiMaxImage, 258*tiles)
}

func ceilDiv(a, b int) int64 {
	return int64((a + b - 1) / b)
}

func object(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}
