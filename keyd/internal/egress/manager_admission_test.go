package egress

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const admissionTaskA = "01JXYZ000000000000000TASKA"
const admissionTaskB = "01JXYZ000000000000000TASKB"

func admissionCell(t *testing.T, m *Manager, id, task string) Opened {
	t.Helper()
	o, err := m.Open(OpenRequest{CellID: id, Role: "brain", Secrets: []string{"anthropic"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = m.BeginPricedTask(id, task, 5, taskPrices(1)); err != nil {
		t.Fatal(err)
	}
	return o
}
func openAdmission(t *testing.T, m *Manager, id string) TaskAdmissionSnapshot {
	t.Helper()
	snap, err := m.ModelAdmission(id)
	if err != nil {
		t.Fatal(err)
	}
	if !snap.Paused || snap.Active != 0 {
		t.Fatal("fresh gate not closed")
	}
	epoch := snap.Epoch
	snap, err = m.SetModelAdmission(id, ModelAdmissionWrite{TaskID: snap.TaskID, GenerationID: snap.GenerationID, State: "open", ExpectedEpoch: &epoch})
	if err != nil {
		t.Fatal(err)
	}
	return snap
}
func sendAdmission(t *testing.T, w *world, o Opened, body io.Reader) (int, string, error) {
	t.Helper()
	req, _ := http.NewRequest("POST", "http://llm.ldot/anthropic/messages", body)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", o.Surrogates["anthropic"])
	res, err := cellClient(w, o).Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(res.Body)
	return res.StatusCode, string(out), err
}
func TestManagerAdmissionActualGatewayDrainsCurrentAndIsolatesCells(t *testing.T) {
	m, w := newManager(t)
	var hits atomic.Int32
	entered := make(chan struct{})
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	w.tlsUpstream("api.anthropic.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				t.Error("Pause cancelled active upstream")
				return
			}
		}
		rw.Header().Set("Content-Type", "application/json")
		io.WriteString(rw, `{"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	a := admissionCell(t, m, "a", admissionTaskA)
	b := admissionCell(t, m, "b", admissionTaskB)
	before, _ := m.d.Budget.Task("a")
	if code, _, err := sendAdmission(t, w, a, strings.NewReader(sonnet)); err != nil || code != 409 || hits.Load() != 0 {
		t.Fatalf("fresh gate reached provider %d %v", code, err)
	}
	unchanged, _ := m.d.Budget.Task("a")
	if unchanged.SpentUSD != before.SpentUSD {
		t.Fatal("refused admission consumed budget")
	}
	sa := openAdmission(t, m, "a")
	openAdmission(t, m, "b")
	finished := make(chan error, 1)
	go func() {
		code, _, err := sendAdmission(t, w, a, strings.NewReader(sonnet))
		if err == nil && code != 200 {
			err = io.ErrUnexpectedEOF
		}
		finished <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("no provider request")
	}
	paused, err := m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: sa.TaskID, GenerationID: sa.GenerationID, State: "paused"})
	if err != nil || !paused.Paused || paused.Active != 1 {
		t.Fatalf("missing active Pause %v %+v", err, paused)
	}
	epoch := paused.Epoch
	if _, err = m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: sa.TaskID, GenerationID: sa.GenerationID, State: "open", ExpectedEpoch: &epoch}); err == nil {
		t.Fatal("resumed an active model step")
	}
	code, raw, err := sendAdmission(t, w, a, strings.NewReader(sonnet))
	var directive map[string]string
	json.Unmarshal([]byte(raw), &directive)
	if err != nil || code != 409 || directive["code"] != "task_paused" || hits.Load() != 1 {
		t.Fatalf("paused provider effects %d %s %v", code, raw, err)
	}
	if code, _, err = sendAdmission(t, w, b, strings.NewReader(sonnet)); err != nil || code != 200 || hits.Load() != 2 {
		t.Fatalf("other cell was paused %d %v", code, err)
	}
	close(release)
	if err = <-finished; err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		paused, err = m.ModelAdmission("a")
		if err != nil {
			t.Fatal(err)
		}
		if paused.Active == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("model did not drain")
		}
		time.Sleep(time.Millisecond)
	}
	epoch = paused.Epoch
	if _, err = m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: sa.TaskID, GenerationID: sa.GenerationID, State: "open", ExpectedEpoch: &epoch}); err != nil {
		t.Fatal(err)
	}
	if code, _, err = sendAdmission(t, w, a, strings.NewReader(sonnet)); err != nil || code != 200 || hits.Load() != 3 {
		t.Fatalf("explicit Resume did not open next step %d %v", code, err)
	}
}
func TestManagerAdmissionUploadedOldBodyCannotStartAfterResume(t *testing.T) {
	m, w := newManager(t)
	var hits atomic.Int32
	w.tlsUpstream("api.anthropic.com", http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		io.WriteString(rw, `{"usage":{"input_tokens":1,"output_tokens":1}}`)
	}))
	a := admissionCell(t, m, "a", admissionTaskA)
	snap := openAdmission(t, m, "a")
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	finished := make(chan int, 1)
	go func() {
		req := httptest.NewRequest("POST", "http://llm.ldot/anthropic/messages", reader)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Api-Key", a.Surrogates["anthropic"])
		req.Header.Set("Proxy-Authorization", "Basic "+basicAuth("cell", a.ProxyToken))
		response := httptest.NewRecorder()
		m.cells["a"].cell.ServeHTTP(response, req)
		finished <- response.Code
	}()
	// A complete request prefix reaches keyd's body reader before the remaining body.
	if _, err := writer.Write([]byte(`{"model":"claude-sonnet-5-5","max_tokens":1,"messages":[`)); err != nil {
		t.Fatal(err)
	}
	paused, err := m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: snap.TaskID, GenerationID: snap.GenerationID, State: "paused"})
	if err != nil {
		t.Fatal(err)
	}
	epoch := paused.Epoch
	if _, err = m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: snap.TaskID, GenerationID: snap.GenerationID, State: "open", ExpectedEpoch: &epoch}); err != nil {
		t.Fatal(err)
	}
	writer.Write([]byte(`{"role":"user","content":"hello"}]}`))
	writer.Close()
	select {
	case code := <-finished:
		if code != 409 || hits.Load() != 0 {
			t.Fatalf("old body replayed %d %d", code, hits.Load())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("old body hung")
	}
}
func TestManagerAdmissionStopRekeyAndUnpricedCannotBeResumed(t *testing.T) {
	m, _ := newManager(t)
	admissionCell(t, m, "a", admissionTaskA)
	old := openAdmission(t, m, "a")
	m.Revoke("a")
	epoch := old.Epoch
	if _, err := m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: old.TaskID, GenerationID: old.GenerationID, State: "open", ExpectedEpoch: &epoch}); err == nil {
		t.Fatal("Stop was undone")
	}
	m.Mint("a", []string{"anthropic"})
	if err := m.BeginPricedTask("a", admissionTaskB, 5, taskPrices(1)); err != nil {
		t.Fatal(err)
	}
	next, err := m.ModelAdmission("a")
	if err != nil || !next.Paused || next.GenerationID == old.GenerationID {
		t.Fatalf("rekey inherited admission %+v %v", next, err)
	}
	if _, err = m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: old.TaskID, GenerationID: old.GenerationID, State: "paused"}); err == nil {
		t.Fatal("old task controlled new generation")
	}
	m.Open(OpenRequest{CellID: "legacy", Role: "brain", Secrets: []string{"anthropic"}})
	m.BeginTask("legacy", "01JXYZ000000000000000TASKC", 5)
	if _, err = m.ModelAdmission("legacy"); err == nil {
		t.Fatal("unpriced task got a control owner")
	}
}

func TestManagerAdmissionTaskReplacementCannotInheritAnOpenGate(t *testing.T) {
	m, _ := newManager(t)
	admissionCell(t, m, "a", admissionTaskA)
	old := openAdmission(t, m, "a")
	if err := m.BeginPricedTask("a", admissionTaskB, 5, taskPrices(1)); err == nil {
		t.Fatal("changed a live task attachment")
	}
	unchanged, _ := m.ModelAdmission("a")
	if unchanged.Paused {
		t.Fatal("failed wrong-task request closed old gate")
	}
	if err := m.EndTask("a"); err != nil {
		t.Fatal(err)
	}
	if err := m.BeginPricedTask("a", admissionTaskB, 5, taskPrices(1)); err != nil {
		t.Fatal(err)
	}
	next, err := m.ModelAdmission("a")
	if err != nil || !next.Paused || next.GenerationID == old.GenerationID {
		t.Fatalf("replacement inherited open admission %+v %v", next, err)
	}
	epoch := old.Epoch
	if _, err = m.SetModelAdmission("a", ModelAdmissionWrite{TaskID: admissionTaskB, GenerationID: old.GenerationID, State: "open", ExpectedEpoch: &epoch}); err == nil {
		t.Fatal("prior generation opened replacement")
	}
}
