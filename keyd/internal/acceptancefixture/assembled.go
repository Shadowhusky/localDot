//go:build localdot_acceptance

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// This deterministic script is compiled only into the acceptance binary. It never
// changes keyd routing, DNS restrictions, authentication, pricing, or lease checks.
type assembledScenario struct {
	mu       sync.Mutex
	next     int
	log      *os.File
	shell    bool
	safety   bool
	recovery bool
}

func newAssembledScenario(path string) *assembledScenario {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	must(err)
	return &assembledScenario{log: f, shell: os.Getenv("LOCALDOT_ASSEMBLED_PENDING") == "shell", safety: os.Getenv("LOCALDOT_ASSEMBLED_SCENARIO") == "safety", recovery: os.Getenv("LOCALDOT_ASSEMBLED_SCENARIO") == "recovery"}
}
func (s *assembledScenario) Close() { _ = s.log.Close() }
func (s *assembledScenario) respond(w http.ResponseWriter, r *http.Request, request map[string]any, body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	stage := s.next
	calls := []struct {
		name string
		args any
	}{
		{"update_plan", map[string]any{"items": []any{map[string]any{"text": "Check the local synthetic task", "status": "doing"}, map[string]any{"text": "Export the sample table", "status": "todo"}}}},
		{"files", map[string]any{"op": "write", "path": "~/Downloads/fixture-demo.html", "content": "<!doctype html><meta charset=utf-8><title>Local synthetic sign-in</title><style>body{font:28px sans-serif;padding:80px;background:#f2f4f8}input{font:28px sans-serif}h1{font-size:36px}</style><h1>Local synthetic sign-in</h1><p>This file does not connect to any account.</p><label>Fake password <input type=password autofocus autocomplete=off></label>"}},
		{"shell", map[string]any{"command": "/usr/local/bin/localdot-chromium \"file://$HOME/Downloads/fixture-demo.html\" >/tmp/task14-browser.log 2>&1 &", "timeout_sec": 10}},
		{"computer", map[string]any{"action": "screenshot"}},
		{"ask_user", map[string]any{"question": "Which synthetic table should I export?", "options": []string{"The sample table"}, "allow_text": true}},
		{"request_takeover", map[string]any{"reason": "login", "note": "Type only the fake acceptance password in the local synthetic sign-in field, then return control."}},
		{"shell", map[string]any{"command": "printf 'task14 pending tool %0128d\n' 0; sleep 0.3; printf 'task14 waiting %0128d\n' 0; sleep 30; printf 'late effect' > \"$HOME/Downloads/late-effect.txt\"", "timeout_sec": 60}},
		{"files", map[string]any{"op": "write", "path": "~/Downloads/assembled.csv", "content": "item,quantity,unit_price,total\nAlpha,3,4.50,13.50\nBeta,2,6.25,12.50\nTOTAL,,,26.00\n"}},
		{"done", map[string]any{"summary": "The synthetic table is ready. This verifies local integration only.", "files": []string{"~/Downloads/assembled.csv"}}},
	}
	if s.safety {
		calls[1].args = map[string]any{"op": "write", "path": "~/Downloads/fixture-demo.html", "content": "<!doctype html><meta charset=utf-8><title>Local safety test</title><style>body{font:28px sans-serif;padding:80px;background:#f2f4f8}input,button{font:28px sans-serif}h1{font-size:36px}</style><h1>Local safety test</h1><p>Only synthetic data. No accounts or network submissions.</p><button>Send sample</button> <button>Buy sample</button><p><label>Fake password <input type=password autofocus autocomplete=off></label></p>"}
		calls[2].args = map[string]any{"command": "/usr/local/bin/localdot-chromium \"file://$HOME/Downloads/fixture-demo.html\" >/tmp/task14-browser.log 2>&1 &", "timeout_sec": 10}
		calls[6].args = map[string]any{"command": "printf 'task14 pending tool %0128d\\n' 0; sleep 0.3; printf 'task14 waiting %0128d\\n' 0; sleep 30; printf 'atomic output complete\\n'; printf 'late effect' > \"$HOME/Downloads/late-effect.txt\"; xdotool key Tab", "timeout_sec": 60}
		// A high-risk simulated Send uses an actual finite local file effect.
		// Native repeat stays in one unchanged focus identity and must stop before dispatch three.
		calls = append(calls[:2], append([]struct {
			name string
			args any
		}{
			{"shell", map[string]any{"command": "printf 'Send sample\\n' >> \"$HOME/Downloads/safety-send-count.txt\"", "timeout_sec": 10}},
		}, calls[2:]...)...)
		calls = append(calls[:8], append([]struct {
			name string
			args any
		}{
			{"computer", map[string]any{"action": "key", "text": "Down", "repeat": 3}},
		}, calls[8:]...)...)
	}
	if !s.shell {
		calls[6].name = "computer"
		calls[6].args = map[string]any{"action": "wait", "ms": 30000}
	}
	calls = append(calls, struct {
		name string
		args any
	}{"files", map[string]any{"op": "write", "path": "~/Downloads/assembled.csv", "content": "item,quantity,unit_price,total\nAlpha,4,4.50,18.00\nBeta,2,6.25,12.50\nTOTAL,,,30.50\n"}}, struct {
		name string
		args any
	}{"done", map[string]any{"summary": "Follow-up updated Alpha quantity to 4; total 30.50.", "files": []string{"~/Downloads/assembled.csv"}}})
	if s.recovery {
		calls = []struct {
			name string
			args any
		}{
			{"shell", map[string]any{"command": "mkdir -p \"$HOME/Downloads\"; printf 'Send sample\\n' >> \"$HOME/Downloads/safety-send-count.txt\"; printf 'task14 pending tool %0128d\\n' 0; sleep 0.3; printf 'task14 waiting %0128d\\n' 0; sleep 30; printf 'late effect' > \"$HOME/Downloads/late-effect.txt\"", "timeout_sec": 60}},
			{"files", map[string]any{"op": "write", "path": "~/Downloads/queued-after-stop.txt", "content": "This must not run after Stop."}},
			{"done", map[string]any{"summary": "Synthetic recovery script completed."}},
		}
	}
	if stage >= 9 && !s.safety && !s.recovery && !strings.Contains(string(body), "task14 follow-up") {
		http.Error(w, "explicit synthetic follow-up marker required", 409)
		return
	}
	if stage == 7 {
		timer := time.NewTimer(time.Second)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-r.Context().Done():
			return
		}
	}
	if stage >= len(calls) {
		http.Error(w, "synthetic script is exhausted", 409)
		return
	}
	// Never persist the request or images. These metadata prove that the model
	// receives no further request while the real manual-control tool is waiting.
	entry := map[string]any{"stage": stage, "model": request["model"], "tool": calls[stage].name, "requestBytes": len(body), "manualSentinelPresent": strings.Contains(string(body), "task14-private-manual-sentinel")}
	encoded, err := json.Marshal(entry)
	must(err)
	_, err = s.log.Write(append(encoded, '\n'))
	must(err)
	must(s.log.Sync())
	s.next++
	args, err := json.Marshal(calls[stage].args)
	must(err)
	delta := map[string]any{"role": "assistant", "content": fmt.Sprintf("Synthetic integration step %d.", stage+1), "tool_calls": []any{map[string]any{"index": 0, "id": fmt.Sprintf("assembled_%d", stage), "type": "function", "function": map[string]any{"name": calls[stage].name, "arguments": string(args)}}}}
	chunk := map[string]any{"id": fmt.Sprintf("assembled-response-%d", stage), "object": "chat.completion.chunk", "created": 1, "model": request["model"], "choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": "tool_calls"}}, "usage": map[string]any{"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}}
	wire, err := json.Marshal(chunk)
	must(err)
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", wire)
}
