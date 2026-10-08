package admin

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/webpush"
)

type fakePusher struct {
	sent []webpush.Request
	err  error
}

func (f *fakePusher) PublicKey() (string, error) { return "BPUBLIC", f.err }

func (f *fakePusher) Send(_ context.Context, req webpush.Request) (webpush.Result, error) {
	if f.err != nil {
		return webpush.Result{}, f.err
	}
	f.sent = append(f.sent, req)
	return webpush.Result{Status: 201}, nil
}

func TestPushRoutesNeedAPusher(t *testing.T) {
	f := newFixture(t)
	if code, _ := f.call(t, "GET", "/v1/push/key", nil); code != http.StatusServiceUnavailable {
		t.Fatalf("key without a pusher: %d", code)
	}
	if code, _ := f.call(t, "POST", "/v1/push/send", map[string]any{"endpoint": "https://web.push.apple.com/x"}); code != http.StatusServiceUnavailable {
		t.Fatalf("send without a pusher: %d", code)
	}
}

func TestPushKeyAndSend(t *testing.T) {
	f := newFixture(t)
	p := &fakePusher{}
	f.s.Push = p
	code, body := f.call(t, "GET", "/v1/push/key", nil)
	if code != http.StatusOK || body["publicKey"] != "BPUBLIC" {
		t.Fatalf("key: %d %v", code, body)
	}
	req := map[string]any{"endpoint": "https://web.push.apple.com/x", "ttl": 60, "urgency": "high", "topic": "abc", "body": "Y2lwaGVy"}
	code, body = f.call(t, "POST", "/v1/push/send", req)
	if code != http.StatusOK || body["status"] != float64(201) || body["gone"] != false || len(p.sent) != 1 {
		t.Fatalf("send: %d %v", code, body)
	}
	req["extra"] = true
	if code, _ := f.call(t, "POST", "/v1/push/send", req); code != http.StatusBadRequest {
		t.Fatalf("an unknown field must be refused, got %d", code)
	}
}

func TestPushFailuresNeverLeakErrorText(t *testing.T) {
	for err, want := range map[error]struct {
		status int
		code   string
	}{
		webpush.ErrNotPushService: {400, "not-push-service"},
		webpush.ErrBadMessage:     {400, "bad-request"},
		webpush.ErrKeyBlocked:     {409, "key-name-taken"},
		webpush.ErrKeyDamaged:     {500, "push-key-damaged"},
		webpush.ErrUnreachable:    {502, "unreachable"},
		context.DeadlineExceeded:  {503, "unavailable"},
	} {
		f := newFixture(t)
		f.s.Push = &fakePusher{err: err}
		code, body := f.call(t, "POST", "/v1/push/send", map[string]any{"endpoint": "https://web.push.apple.com/x", "ttl": 1, "urgency": "low", "body": "eA"})
		got := body["error"].(map[string]any)
		if code != want.status || got["code"] != want.code || strings.Contains(got["message"].(string), err.Error()) {
			t.Fatalf("%v: %d %v", err, code, got)
		}
	}
}
