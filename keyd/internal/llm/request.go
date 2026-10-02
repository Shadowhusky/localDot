package llm

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"
	"strings"
)

var (
	ErrDuplicateModel = errors.New("llm: the request names its model twice")
	errNotObject      = errors.New("llm: the request body is not a JSON object")
	errTwoConfigs     = errors.New("llm: the request names its generation config twice")
)

// The APIs whose bodies carry images, as keys.Op names them.
const (
	BodyAnthropic = "anthropic"
	BodyChat      = "chat"
	BodyResponses = "responses"
	BodyGemini    = "gemini"
	// Chat completions whose images are billed by another rule than OpenAI's (Part 5a's amendment):
	// Mistral's, and OpenRouter's, which serves every vendor's models.
	BodyMistral    = "mistral"
	BodyOpenRouter = "openrouter"
)

// BodyCompletions is OpenAI's completions API, whose prompt may be a list of prompts.
const BodyCompletions = "completions"

// ModelFromJSON returns the top-level "model" of a request body, or "" when there is none. A body
// naming its model twice, in any letter case, is refused, and so is one naming it in capitals:
// keyd and the provider might read different ones.
func ModelFromJSON(body []byte) (string, error) {
	var model string
	seen := false
	err := fields(body, func(key string, raw json.RawMessage) error {
		if !strings.EqualFold(key, "model") {
			return nil
		}
		if seen {
			return ErrDuplicateModel
		}
		seen = true
		if key != "model" {
			return errors.New(`llm: the request names its model as "` + key + `"`)
		}
		if err := json.Unmarshal(raw, &model); err != nil {
			return errors.New("llm: model is not a string")
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	return model, nil
}

// ChoiceError refuses a request for more than one answer, which the provider bills in full for
// each answer under a single output cap, or for a choice of models (OpenRouter's `models`
// fallbacks), which can answer with a model off the allowlist at its own price.
type ChoiceError struct{ Field string }

func (e *ChoiceError) Error() string {
	return "llm: " + e.Field + " asks for more than one answer or model"
}

// Request is what a gateway request's body can cost before keyd sets its output cap.
type Request struct {
	// Input is the most input tokens the provider bills for the body: its text at three bytes a
	// token and each image by the provider's rule.
	Input int64
	// Cap is the smallest output cap the body names, when HasCap.
	Cap    int64
	HasCap bool
}

// capFields and choiceFields are folded as fold folds a key: every provider's output caps and
// answer counts, in the letter cases and spellings Go and protobuf servers also read.
var (
	capFields    = []string{"maxtokens", "maxcompletiontokens", "maxoutputtokens"}
	choiceFields = []string{"n", "bestof", "candidatecount"}
)

// ReadRequest reads the body of a request to a model through api (an op's Body). It refuses a
// count of answers other than one, at the top level and in Gemini's generation config; a prompt
// list of more than one element on the completions API, which answers each prompt under the one
// cap; a list of models to fall back on; and a body naming the generation config twice. A cap is a whole number from 1 to a
// billion, or 0 for Anthropic, which then writes nothing; null, strings and fractions are no cap.
func ReadRequest(api, model string, body []byte) (Request, error) {
	top, err := members(body)
	if err != nil {
		return Request{}, err
	}
	var req Request
	look := func(ms []member) error {
		for _, m := range ms {
			k := fold(m.key)
			if slices.Contains(choiceFields, k) && !oneOrNull(m.raw) {
				return &ChoiceError{Field: m.key}
			}
			if api == BodyCompletions && k == "prompt" && several(m.raw) {
				return &ChoiceError{Field: m.key}
			}
			if k == "models" && !isNull(m.raw) {
				return &ChoiceError{Field: m.key}
			}
			if !slices.Contains(capFields, k) {
				continue
			}
			if n, ok := capValue(m.raw, api == BodyAnthropic); ok && (!req.HasCap || n < req.Cap) {
				req.Cap, req.HasCap = n, true
			}
		}
		return nil
	}
	if err := look(top); err != nil {
		return Request{}, err
	}
	configs := 0
	for _, m := range top {
		if fold(m.key) != "generationconfig" {
			continue
		}
		if configs++; configs > 1 {
			return Request{}, errTwoConfigs
		}
		if isNull(m.raw) {
			continue
		}
		inner, err := members(m.raw)
		if err != nil {
			return Request{}, err
		}
		if err := look(inner); err != nil {
			return Request{}, err
		}
	}
	// Invalid UTF-8 in an image's data decodes to three bytes for each byte of the body, so the
	// data counts at most the body's length, and the text's share is never below nothing.
	data, images := imagesIn(api, model, body)
	req.Input = max(0, (int64(len(body))-min(data, int64(len(body)))+2)/3) + images
	return req, nil
}

// WithCap returns the body with tokens as its output cap in capField, the provider's own field,
// and every other output cap removed, at the top level and in Gemini's generation config, so the
// provider reads keyd's cap whichever field it prefers. capField is a top-level field, or
// "generationConfig.maxOutputTokens".
func WithCap(capField string, body []byte, tokens int64) ([]byte, error) {
	limit := json.RawMessage(strconv.FormatInt(tokens, 10))
	parent, field, nested := strings.Cut(capField, ".")
	if !nested {
		field = parent
	}
	ms, err := members(body)
	if err != nil {
		return nil, err
	}
	out := make([]member, 0, len(ms)+1)
	placed := false
	for _, m := range ms {
		k := fold(m.key)
		if slices.Contains(capFields, k) {
			continue
		}
		if k == "generationconfig" {
			var inner []member
			if !isNull(m.raw) {
				if inner, err = members(m.raw); err != nil {
					return nil, err
				}
			}
			inner = slices.DeleteFunc(inner, func(m member) bool { return slices.Contains(capFields, fold(m.key)) })
			if nested && !placed {
				inner, placed = append(inner, member{field, limit}), true
			}
			m.raw = encode(inner)
		}
		out = append(out, m)
	}
	switch {
	case !nested:
		out = append(out, member{field, limit})
	case !placed:
		out = append(out, member{parent, encode([]member{{field, limit}})})
	}
	return encode(out), nil
}

func capValue(raw json.RawMessage, zeroOK bool) (int64, bool) {
	s := string(bytes.TrimSpace(raw))
	if s == "" || len(s) > 10 || strings.Trim(s, "0123456789") != "" {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil && n <= 1e9 && (n >= 1 || zeroOK && n == 0)
}

func oneOrNull(raw json.RawMessage) bool {
	s := string(bytes.TrimSpace(raw))
	return s == "1" || s == "null"
}

func isNull(raw json.RawMessage) bool {
	return string(bytes.TrimSpace(raw)) == "null"
}

// several reports whether raw is a list of more than one element.
func several(raw json.RawMessage) bool {
	var list []json.RawMessage
	return json.Unmarshal(raw, &list) == nil && len(list) > 1
}

func fold(key string) string {
	return strings.ToLower(strings.ReplaceAll(key, "_", ""))
}

type member struct {
	key string
	raw json.RawMessage
}

func members(body []byte) ([]member, error) {
	var out []member
	err := fields(body, func(key string, raw json.RawMessage) error {
		out = append(out, member{key, raw})
		return nil
	})
	return out, err
}

// encode writes the members back as an object, each value byte for byte as it came.
func encode(ms []member) json.RawMessage {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	b.WriteByte('{')
	for i, m := range ms {
		if i > 0 {
			b.WriteByte(',')
		}
		enc.Encode(m.key)
		b.Truncate(b.Len() - 1)
		b.WriteByte(':')
		b.Write(m.raw)
	}
	b.WriteByte('}')
	return b.Bytes()
}

// fields calls fn with each key of a JSON object and its raw value, in order, duplicates
// included.
func fields(body []byte, fn func(key string, raw json.RawMessage) error) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return errNotObject
	}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return err
		}
		key, _ := tok.(string)
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return err
		}
		if err := fn(key, raw); err != nil {
			return err
		}
	}
	if _, err := dec.Token(); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return errors.New("llm: the request contains trailing data")
	}
	return nil
}
