package admin

import (
	"bytes"
	"errors"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/egress"
	"github.com/shadowhusky/localdot/keyd/internal/keys"
	"github.com/shadowhusky/localdot/keyd/internal/vault"
)

func TestAdminRequiresOneBoundedJSONObject(t *testing.T) {
	f := newFixture(t)
	for name, body := range map[string]string{
		"second document":               `{"models":[]} {"models":[]}`,
		"trailing junk":                 `{"models":[]} garbage`,
		"oversized trailing whitespace": `{"models":[]}` + strings.Repeat(" ", maxBody),
		"null document":                 `null`,
		"unknown field":                 `{"models":[],"modles":[]}`,
	} {
		t.Run(name, func(t *testing.T) {
			req, _ := http.NewRequest("PUT", f.srv.URL+"/v1/llm/routes/anthropic/models", strings.NewReader(body))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("accepted malformed body: %d", resp.StatusCode)
			}
		})
	}
}

type errorStore struct {
	*vault.Memory
	failPut, failDelete bool
}

func (s *errorStore) Put(id string, value []byte, binding string) error {
	if s.failPut {
		return errors.New("backend reported " + fakeKey)
	}
	return s.Memory.Put(id, value, binding)
}
func (s *errorStore) Delete(id string) error {
	if s.failDelete {
		return errors.New("backend reported " + fakeKey)
	}
	return s.Memory.Delete(id)
}

func TestAdminDoesNotExposeVaultBackendErrors(t *testing.T) {
	for _, operation := range []string{"put", "delete"} {
		t.Run(operation, func(t *testing.T) {
			store := &errorStore{Memory: vault.NewMemory()}
			f := newFixtureWithDeps(t, func(d *egress.Deps) { d.Vault, _ = vault.Open(store, "") })
			if code, _ := f.sealedPut(t, "weather", weather(), fakeKey); code != 200 {
				t.Fatal(code)
			}
			store.failPut, store.failDelete = operation == "put", operation == "delete"
			var code int
			var body map[string]any
			if operation == "put" {
				code, body = f.sealedPut(t, "weather", weather(), fakeKey)
			} else {
				code, body = f.call(t, "DELETE", "/v1/secrets/weather", nil)
			}
			if code != 500 {
				t.Fatalf("failed %s: %d", operation, code)
			}
			message, _ := body["error"].(map[string]any)["message"].(string)
			if strings.Contains(message, fakeKey) {
				t.Fatalf("backend value leaked in %s response", operation)
			}
		})
	}
}

func TestChangingModelsOrLimitsCancelsActiveGatewayRequests(t *testing.T) {
	for _, change := range []string{"models", "limits"} {
		t.Run(change, func(t *testing.T) {
			entered, stopped := make(chan struct{}), make(chan struct{})
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte("data: waiting\n\n"))
				w.(http.Flusher).Flush()
				close(entered)
				<-r.Context().Done()
				close(stopped)
			}))
			defer provider.Close()
			f := newFixtureWithDeps(t, func(d *egress.Deps) {
				b := keys.LocalRoutes()["lmstudio"]
				b.Upstream, _ = url.Parse(provider.URL + "/v1")
				d.Local = map[string]keys.Binding{"lmstudio": b}
				d.LocalDialer = egress.PinnedFor(d.Local)
			})
			if code, _ := f.call(t, "PUT", "/v1/llm/routes/lmstudio/models", map[string]any{"models": []map[string]any{{"id": "local"}}}); code != 200 {
				t.Fatal(code)
			}
			code, opened := f.call(t, "POST", "/v1/cells", map[string]any{"cellId": "brain", "role": "brain"})
			if code != 201 {
				t.Fatal(code)
			}
			// This retained legacy cancellation fixture first opens a valid priced
			// owner, then uses its private test ledger to simulate an old attachment.
			// Production model-control routes never grant unpriced admission.
			pricing := llm.TaskPricing{V: 1, Routes: []llm.TaskPricingRoute{{Route: "lmstudio", Models: []llm.Price{{Model: "local", MaxOutput: 1}}}}}
			if err := f.s.Manager.BeginPricedTask("brain", admissionTask, 5, pricing); err != nil {
				t.Fatal(err)
			}
			snapshot, err := f.s.Manager.ModelAdmission("brain")
			if err != nil {
				t.Fatal(err)
			}
			epoch := snapshot.Epoch
			if _, err = f.s.Manager.SetModelAdmission("brain", egress.ModelAdmissionWrite{TaskID: admissionTask, GenerationID: snapshot.GenerationID, State: "open", ExpectedEpoch: &epoch}); err != nil {
				t.Fatal(err)
			}
			f.s.Budget.End("brain")
			if err = f.s.Budget.Begin("brain", "session", 5); err != nil {
				t.Fatal(err)
			}
			if code, _ := f.call(t, "PUT", "/v1/cells/brain/task", map[string]any{"taskId": "session"}); code != 204 {
				t.Fatal(code)
			}
			proxy := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(int(opened["port"].(float64)))), User: url.UserPassword("cell", opened["proxyToken"].(string))}
			transport := &http.Transport{Proxy: http.ProxyURL(proxy)}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 5 * time.Second}
			resp, err := client.Post("http://llm.ldot/lmstudio/chat/completions", "application/json", strings.NewReader(`{"model":"local","stream":true}`))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			<-entered
			if change == "models" {
				code, _ = f.call(t, "PUT", "/v1/llm/routes/lmstudio/models", map[string]any{"models": []any{}})
			} else {
				code, _ = f.call(t, "PUT", "/v1/budget", map[string]any{"perTaskUSD": 2, "perDayUSD": 10})
			}
			if code != 200 {
				t.Fatal(code)
			}
			select {
			case <-stopped:
			case <-time.After(time.Second):
				resp.Body.Close()
				t.Fatal("a policy update left the old provider request running")
			}
			if change == "models" {
				next, err := client.Post("http://llm.ldot/lmstudio/chat/completions", "application/json", strings.NewReader(`{"model":"local"}`))
				if err != nil {
					t.Fatal(err)
				}
				defer next.Body.Close()
				if next.StatusCode != 409 || next.Header.Get("X-Keyd-Reason") != "task_paused" {
					t.Fatalf("fresh model gate after policy publication was not closed: %d", next.StatusCode)
				}
			}
		})
	}
}

func TestListenDoesNotDeleteAnUnrelatedFile(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "keyd-socket-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "admin.sock")
	content := []byte("user file")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	ln, err := Listen(path)
	if err == nil {
		ln.Close()
		t.Fatal("Listen replaced an ordinary file")
	}
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, content) {
		t.Fatalf("file changed: %q %v", got, err)
	}
}

func TestEventsStopsWhenItsContextIsCanceled(t *testing.T) {
	f := newFixture(t)
	resp, err := http.Get(f.srv.URL + "/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// Closing the server must not wait forever on an abandoned NDJSON subscriber.
	closed := make(chan struct{})
	go func() { f.srv.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("event handler survived disconnection")
	}
}
