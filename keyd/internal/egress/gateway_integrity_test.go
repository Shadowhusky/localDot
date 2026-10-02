package egress

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
	"github.com/shadowhusky/localdot/keyd/internal/llm"
)

func admittedCost(t *testing.T, body string) int64 {
	t.Helper()
	req, err := llm.ReadRequest(llm.BodyAnthropic, "claude-sonnet-5-5", []byte(body))
	if err != nil {
		t.Fatal(err)
	}
	return (llm.Price{Input: 3, Output: 15}).Ceiling(req.Input, req.Cap)
}

func TestStopBeforeResponseHeadersKeepsTheAdmittedCharge(t *testing.T) {
	arrived, stopped := make(chan struct{}), make(chan struct{})
	g := newGateway(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		close(arrived)
		<-r.Context().Done()
		close(stopped)
	}), nil)
	result := make(chan int, 1)
	go func() { result <- g.send(g.cell, g.tok, fourFifty) }()
	select {
	case <-arrived:
	case <-time.After(3 * time.Second):
		t.Fatal("the provider did not receive the request")
	}
	g.cell.Revoke()
	select {
	case status := <-result:
		if status != http.StatusServiceUnavailable {
			t.Fatalf("Stop answered %d", status)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Stop did not finish the request")
	}
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("the provider continued after Stop")
	}
	line := g.waitLine(reasonIs(ReasonRevoked))
	info, _ := g.budget.Task("c1")
	if want := admittedCost(t, fourFifty); line.CostMicroUSD != want || info.SpentUSD != float64(want)/1e6 {
		t.Fatalf("Stop refunded work already sent upstream: audit=%+v task=%+v want=%d", line, info, want)
	}
}

func TestAnUpstreamDisconnectBeforeHeadersKeepsTheAdmittedCharge(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		panic(http.ErrAbortHandler)
	}), nil)
	resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("upstream disconnect answered %d", resp.StatusCode)
	}
	line := g.waitLine(reasonIs(ReasonUpstream))
	if want := admittedCost(t, sonnet); line.CostMicroUSD != want || line.Usage != "estimated" {
		t.Fatalf("unknown upstream outcome was refunded: %+v, want %d", line, want)
	}
}

func TestASuccessfulEmptyResponseKeepsTheAdmittedCharge(t *testing.T) {
	g := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}), nil)
	resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("empty response: %d", resp.StatusCode)
	}
	line := g.waitLine(func(l audit.Line) bool { return l.Mode == "gateway" && l.Status == http.StatusNoContent })
	if want := admittedCost(t, sonnet); line.CostMicroUSD != want || line.Usage != "estimated" {
		t.Fatalf("successful answer without usage was refunded: %+v, want %d", line, want)
	}
}

func TestAnUnreadableAnswerChargesOnlyWhenTheProviderSucceeded(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			g := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Encoding", "br")
				w.WriteHeader(status)
				io.WriteString(w, "unreadable response")
			}), nil)
			resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
			if resp.StatusCode != http.StatusBadGateway || resp.Header.Get("X-Keyd-Reason") != ReasonEncoding {
				t.Fatalf("unsupported encoding: %d %v", resp.StatusCode, resp.Header)
			}
			line := g.waitLine(reasonIs(ReasonEncoding))
			want := int64(0)
			if status == http.StatusOK {
				want = admittedCost(t, sonnet)
			}
			if line.CostMicroUSD != want {
				t.Fatalf("upstream status %d: cost %d, want %d", status, line.CostMicroUSD, want)
			}
		})
	}
}

func TestTheGatewayRequiresItsExactVirtualAuthority(t *testing.T) {
	var hits atomic.Int32
	g := newGateway(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		io.WriteString(w, `{"usage":{"input_tokens":1,"output_tokens":1}}`)
	}), nil)
	for _, authority := range []string{"llm.ldot:443", "llm.ldot:8080", "llm.ldot."} {
		resp, _ := g.post(t, "http://"+authority+"/anthropic/messages", g.key(), sonnet)
		if resp.StatusCode < 400 {
			t.Fatalf("gateway accepted authority %q", authority)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("invalid authorities reached the provider %d times", hits.Load())
	}
	resp, _ := g.post(t, "http://LLM.LDOT:80/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != http.StatusOK || hits.Load() != 1 {
		t.Fatalf("valid authority: %d, provider hits %d", resp.StatusCode, hits.Load())
	}
}

func TestALedgerFailureIsUnavailableAndNeverReachesTheProvider(t *testing.T) {
	var hits atomic.Int32
	g := newGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
	b, err := llm.OpenBudget(filepath.Join(t.TempDir(), "missing", "spend.json"), g.settings.Limits, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Begin("c1", "task-1", 5); err == nil {
		t.Fatal("expected the ledger write to fail")
	}
	g.cell.deps.Budget = b
	resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != "budget-unavailable" || hits.Load() != 0 {
		t.Fatalf("ledger failure: %d %q, provider hits %d", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
}

func TestMissingGatewayBookkeepingFailsClosed(t *testing.T) {
	for _, missing := range []string{"budget", "settings"} {
		t.Run(missing, func(t *testing.T) {
			var hits atomic.Int32
			g := newGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
			if missing == "budget" {
				g.cell.deps.Budget = nil
			} else {
				g.cell.deps.Settings = nil
			}
			resp, _ := g.post(t, "http://llm.ldot/anthropic/messages", g.key(), sonnet)
			if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != "budget-unavailable" || hits.Load() != 0 {
				t.Fatalf("missing %s: %d %q, provider hits %d", missing, resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
			}
		})
	}
}

func TestStopInterruptsAnUnfinishedGatewayUpload(t *testing.T) {
	var hits atomic.Int32
	g := newGateway(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hits.Add(1) }), nil)
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", g.cell.Port()))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(3 * time.Second))
	auth := base64.StdEncoding.EncodeToString([]byte("cell:" + testToken))
	fmt.Fprintf(conn, "POST http://llm.ldot/anthropic/messages HTTP/1.1\r\nHost: llm.ldot\r\nProxy-Authorization: Basic %s\r\nX-Api-Key: %s\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n", auth, g.tok)
	reader := bufio.NewReader(conn)
	interim, err := http.ReadResponse(reader, &http.Request{Method: http.MethodPost})
	if err != nil || interim.StatusCode != http.StatusContinue {
		t.Fatalf("the gateway did not begin reading the body: %v %v", interim, err)
	}
	interim.Body.Close()
	io.WriteString(conn, "{")
	g.cell.Revoke()
	conn.SetReadDeadline(time.Now().Add(time.Second))
	resp, err := http.ReadResponse(reader, &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatalf("Stop left the upload waiting for the rest of the body: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable || resp.Header.Get("X-Keyd-Reason") != ReasonRevoked || hits.Load() != 0 {
		t.Fatalf("upload Stop: %d %q, provider hits %d", resp.StatusCode, resp.Header.Get("X-Keyd-Reason"), hits.Load())
	}
}
