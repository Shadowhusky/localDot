package llm

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"testing"
)

// picture is a blank image of the size, as base64 of a PNG or a JPEG.
func picture(t *testing.T, format string, w, h int) string {
	t.Helper()
	var b bytes.Buffer
	img := image.NewGray(image.Rect(0, 0, w, h))
	encode := png.Encode
	if format == "jpeg" {
		encode = func(w io.Writer, img image.Image) error { return jpeg.Encode(w, img, nil) }
	}
	if err := encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(b.Bytes())
}

func TestImagesArePricedByTheProvidersRule(t *testing.T) {
	shot := picture(t, "png", 1280, 800)
	photo := picture(t, "jpeg", 2000, 1500)
	wide := picture(t, "png", 4000, 600)
	gif := base64.StdEncoding.EncodeToString([]byte("GIF89a\x00\x05\x20\x03"))
	cases := []struct {
		name, api, model, body string
		data                   string
		tokens                 int64
	}{
		// ⌈1280/28⌉·⌈800/28⌉ = 46·29 patches; ⌈2000/28⌉·⌈1500/28⌉ = 72·54.
		{"anthropic screenshot", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + shot + `"}}]}]}`, shot, 1_334},
		{"anthropic tool result", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"` + photo + `"}}]}]}]}`, photo, 3_888},
		{"anthropic by url", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://example.test/a.png"}}]}]}`, "", 4_784},
		{"anthropic gif", BodyAnthropic, "m", `{"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/gif","data":"` + gif + `"}}]}]}`, gif, 4_784},
		// 40·25 patches × 2.46 = 2,460, more than 85 + 170·6 tiles = 1,105; a photo's 63·47 × 2.46.
		{"openai chat", BodyChat, "gpt-6.1-sol", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + shot + `","detail":"high"}}]}]}`, shot, 2_460},
		{"openai screenshot", BodyResponses, "gpt-6.1-sol", `{"input":[{"type":"computer_call_output","call_id":"c","output":{"type":"computer_screenshot","image_url":"data:image/png;base64,` + shot + `"}}]}`, shot, 2_460},
		{"openai input image", BodyResponses, "gpt-6.1-sol", `{"input":[{"role":"user","content":[{"type":"input_image","image_url":"data:image/jpeg;base64,` + photo + `"}]}]}`, photo, 7_285},
		{"gpt-4o-mini", BodyChat, "gpt-4o-mini", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + shot + `"}}]}]}`, shot, 2_833 + 5_667*6},
		{"openai by url", BodyChat, "gpt-6.1-sol", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.test/a.png"}}]}]}`, "", 73_800},
		// Gemini 3's most, 2,240, is more than 6 crops of 533 pixels; a wide image is 20 crops of 400.
		{"gemini", BodyGemini, "m", `{"contents":[{"role":"user","parts":[{"inlineData":{"mimeType":"image/png","data":"` + shot + `"}}]}]}`, shot, 2_240},
		{"gemini wide", BodyGemini, "m", `{"contents":[{"parts":[{"inline_data":{"mime_type":"image/png","data":"` + wide + `"}}]}]}`, wide, 20 * 258},
		{"gemini function response", BodyGemini, "m", `{"contents":[{"parts":[{"functionResponse":{"name":"f","parts":[{"inlineData":{"mimeType":"image/png","data":"` + shot + `"}}]}}]}]}`, shot, 2_240},
		{"gemini file", BodyGemini, "m", `{"contents":[{"parts":[{"fileData":{"mimeType":"image/png","fileUri":"https://example.test/a.png"}}]}]}`, "", 2_240},
		{"an image as text", BodyChat, "m", `{"messages":[{"role":"user","content":"` + shot + `"}]}`, "", 0},
		{"no images in completions", "completions", "m", `{"prompt":"data:image/png;base64,` + shot + `"}`, "", 0},
		// Mistral: 80·50 patches + 50 row breaks + 1; a photo, 125·94 + 94 + 1, in Mistral's own
		// image_url string; one it cannot size holds a 2048-pixel square's 16,513 (P5a-R31).
		{"mistral screenshot", BodyMistral, "mistral-medium-3", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":"data:image/png;base64,` + shot + `"}]}]}`, shot, 4_051},
		{"mistral photo", BodyMistral, "mistral-medium-3", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,` + photo + `"}}]}]}`, photo, 11_845},
		{"mistral by url", BodyMistral, "mistral-medium-3", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":"https://example.test/a.png"}]}]}`, "", 16_513},
		// OpenRouter: the largest rule keyd knows, Mistral's for these, OpenAI's for a URL.
		{"openrouter screenshot", BodyOpenRouter, "mistralai/mistral-medium-3", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + shot + `"}}]}]}`, shot, 4_051},
		{"openrouter wide", BodyOpenRouter, "google/gemini-3.6-flash", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"data:image/png;base64,` + wide + `"}}]}]}`, wide, 250*38 + 38 + 1},
		{"openrouter by url", BodyOpenRouter, "m", `{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.test/a.png"}}]}]}`, "", 73_800},
	}
	for _, c := range cases {
		data, tokens := imagesIn(c.api, c.model, []byte(c.body))
		if data != int64(len(c.data)) || tokens != c.tokens {
			t.Errorf("%s: %d bytes of image data, %d tokens; want %d, %d", c.name, data, tokens, len(c.data), c.tokens)
		}
		req, err := ReadRequest(c.api, c.model, []byte(c.body))
		if want := (int64(len(c.body)-len(c.data))+2)/3 + c.tokens; err != nil || req.Input != want {
			t.Errorf("%s: input %d tokens, %v; want %d", c.name, req.Input, err, want)
		}
	}
}
