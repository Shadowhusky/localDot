### Task 5: The audit log and the event hub

"One hash-chained JSON line per decision — time, cell, surrogate id (never the value), host,
method, path, status, bytes, decision — under `~/.localdot/keyd/`." Each line carries the SHA-256
of the line before it, so an edit, a deletion or a reordering breaks the chain; a partial last line
left by a crash is cut off and the repair is itself a line. The format extends the shape keyd adapts
from iron-proxy (one record per decision, secrets named, never valued) with the cell, the listener,
the hash chain and the surrogate's ID (P4a-R17). `Write` turns surrogate-shaped text in the fields
a request controls (method, host, path, SNI, route, model, detail) into `surrogate:<ID>`, so neither
the log nor the `key.use` events made from its lines hold one (review 1, M2). A write that fails is
kept as `Err` until a write succeeds again, and the bytes a partial write left are cut off before
the next line, so the chain stays intact; keyd swaps no secret while `Err` is set (review 1, M4).
The hub fans events out to admin-socket subscribers without ever blocking the data plane; a
subscriber that falls behind is told how many it missed.

**Files:**
- Create: `keyd/internal/audit/audit.go`, `keyd/internal/events/events.go`
- Test: `keyd/internal/audit/audit_test.go`, `keyd/internal/events/events_test.go`

**Interfaces:**
- Produces (audit): kinds `KindConnect = "connect"`, `KindRequest = "request"`, `KindAdmin = "admin"`,
  `KindKeyd = "keyd"`; decisions `Allow`, `Deny`, `Error`; `Line` (fields and JSON names in
  "Interfaces Part 4b builds on"); `Open(path string) (*Log, error)`, `(*Log).Write(Line) (Line, error)`
  (fills `V`, `Seq`, `Time`, `Prev`, writes surrogates as their IDs, and returns the line as
  written, also on failure), `(*Log).Err() error`, `(*Log).OnWrite(func(Line))`,
  `(*Log).Close() error`, `Verify(r io.Reader) (int, error)`.
- Produces (events): `TypeKeyUse = "key.use"`, `TypeBudget = "budget.exceeded"`, `TypeDropped = "events.dropped"`;
  `Event{Type, Cell string; Time time.Time; Data any}`; `KeyUse{SecretID, Host, Method, Path, Decision}`
  (JSON `secretId host method path decision`, the data of @localdot/protocol's `key.use`);
  `Budget{Scope, TaskID string; LimitUSD, SpentUSD float64}`; `Dropped{Count int}`;
  `NewHub() *Hub`, `(*Hub).Subscribe(buf int) (<-chan Event, func())`, `(*Hub).Publish(Event)`.

- [ ] **Step 1: Write the failing tests**

`keyd/internal/audit/audit_test.go`:
```go
package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

func openLog(t *testing.T) (*Log, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "audit.jsonl")
	l, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l, path
}

func lines(t *testing.T, path string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
}

func TestWriteChainsEachLineToThePrevious(t *testing.T) {
	l, path := openLog(t)
	for _, host := range []string{"a.example.test", "b.example.test", "c.example.test"} {
		if _, err := l.Write(Line{Kind: KindRequest, Cell: "c1", Host: host, Decision: Allow}); err != nil {
			t.Fatal(err)
		}
	}
	got := lines(t, path)
	if len(got) != 3 {
		t.Fatalf("%d lines, want 3", len(got))
	}
	prev := strings.Repeat("0", 64)
	for i, raw := range got {
		var line Line
		if err := json.Unmarshal(raw, &line); err != nil {
			t.Fatal(err)
		}
		if line.Seq != uint64(i+1) || line.Prev != prev || line.V != 1 {
			t.Fatalf("line %d: seq %d prev %s v %d", i+1, line.Seq, line.Prev, line.V)
		}
		if _, err := time.Parse(time.RFC3339Nano, line.Time); err != nil {
			t.Fatalf("line %d time %q: %v", i+1, line.Time, err)
		}
		sum := sha256.Sum256(raw)
		prev = hex.EncodeToString(sum[:])
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v, want 0600", info.Mode().Perm())
	}
}

func TestVerifyAcceptsAnIntactLogAndCatchesEdits(t *testing.T) {
	l, path := openLog(t)
	for i := range 4 {
		if _, err := l.Write(Line{Kind: KindRequest, Host: "h.example.test", Status: 200 + i, Decision: Allow}); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 4 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
	all := lines(t, path)
	edited := bytes.Replace(data, []byte(`"status":201`), []byte(`"status":403`), 1)
	dropped := bytes.Join(append(append([][]byte{}, all[:1]...), all[2:]...), []byte("\n"))
	swapped := bytes.Join([][]byte{all[0], all[2], all[1], all[3]}, []byte("\n"))
	for name, bad := range map[string][]byte{"edited": edited, "dropped": dropped, "reordered": swapped} {
		if _, err := Verify(bytes.NewReader(bad)); err == nil {
			t.Errorf("%s log verified", name)
		}
	}
}

func TestOpenResumesTheChain(t *testing.T) {
	l, path := openLog(t)
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
		t.Fatal(err)
	}
	l.Close()
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	line, err := again.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"})
	if err != nil {
		t.Fatal(err)
	}
	if line.Seq != 2 {
		t.Fatalf("seq %d after reopen, want 2", line.Seq)
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 2 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
}

func TestOpenDropsAPartialLastLineAndSaysSo(t *testing.T) {
	l, path := openLog(t)
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
		t.Fatal(err)
	}
	l.Close()
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(`{"v":1,"seq":2,"tim`)
	f.Close()
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	again.Close()
	got := lines(t, path)
	if len(got) != 2 || !bytes.Contains(got[1], []byte(`"reason":"audit-repair"`)) || !bytes.Contains(got[1], []byte(`"bytesIn":19`)) {
		t.Fatalf("after repair: %s", bytes.Join(got, []byte("\n")))
	}
	data, _ := os.ReadFile(path)
	if _, err := Verify(bytes.NewReader(data)); err != nil {
		t.Fatalf("Verify after repair: %v", err)
	}
}

func TestConcurrentWritesKeepTheChain(t *testing.T) {
	l, path := openLog(t)
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			for range 25 {
				if _, err := l.Write(Line{Kind: KindRequest, Decision: Allow}); err != nil {
					t.Error(err)
				}
			}
		})
	}
	wg.Wait()
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 500 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
}

func TestWriteCallsTheHookWithTheWrittenLine(t *testing.T) {
	l, _ := openLog(t)
	var got []Line
	l.OnWrite(func(line Line) { got = append(got, line) })
	if _, err := l.Write(Line{Kind: KindRequest, SecretID: "weather", Decision: Deny, Reason: "misplaced-surrogate"}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Seq != 1 || got[0].SecretID != "weather" {
		t.Fatalf("hook saw %+v", got)
	}
}

// failingFile writes the first keep bytes it is given, then fails, as a full disk does.
type failingFile struct {
	file
	keep int
}

func (f *failingFile) Write(p []byte) (int, error) {
	n, _ := f.file.Write(p[:min(len(p), f.keep)])
	return n, errors.New("no space left on device")
}

func TestAFailedWriteIsCutOffReportedAndCleared(t *testing.T) {
	l, path := openLog(t)
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
		t.Fatal(err)
	}
	healthy := l.f
	l.f = &failingFile{file: healthy, keep: 10}
	if _, err := l.Write(Line{Kind: KindRequest, Decision: Allow}); err == nil || l.Err() == nil {
		t.Fatalf("a failed write: err %v, Err %v", err, l.Err())
	}
	l.f = healthy
	if _, err := l.Write(Line{Kind: KindRequest, Decision: Deny}); err != nil {
		t.Fatal(err)
	}
	if err := l.Err(); err != nil {
		t.Fatalf("Err after a good write: %v", err)
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 2 {
		t.Fatalf("Verify = %d, %v: the failed write's bytes were left in the chain", n, err)
	}
}

func TestSurrogatesAreWrittenAsTheirIDs(t *testing.T) {
	l, path := openLog(t)
	tok, _ := surrogate.Mint("key")
	var hooked Line
	l.OnWrite(func(line Line) { hooked = line })
	line, err := l.Write(Line{Kind: KindRequest, Method: "GET", Host: tok + ".example.test", Path: "/keys/" + tok, Detail: "lookup " + tok, Decision: Deny})
	if err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	named := "surrogate:" + surrogate.ID(tok)
	if strings.Contains(string(data), tok) || strings.Contains(hooked.Path+hooked.Host+hooked.Detail, tok) || line.Path != "/keys/"+named || line.Host != named+".example.test" {
		t.Fatalf("written %s; returned %+v", data, line)
	}
}
```

`keyd/internal/events/events_test.go`:
```go
package events

import (
	"testing"
	"time"
)

func receive(t *testing.T, ch <-chan Event) Event {
	t.Helper()
	select {
	case e, ok := <-ch:
		if !ok {
			t.Fatal("channel closed")
		}
		return e
	case <-time.After(time.Second):
		t.Fatal("no event")
	}
	return Event{}
}

func TestPublishReachesEverySubscriber(t *testing.T) {
	h := NewHub()
	a, cancelA := h.Subscribe(4)
	b, cancelB := h.Subscribe(4)
	defer cancelA()
	defer cancelB()
	h.Publish(Event{Type: TypeKeyUse, Cell: "c1", Data: KeyUse{SecretID: "anthropic", Host: "api.anthropic.com", Method: "POST", Path: "/v1/messages", Decision: "allow"}})
	for _, ch := range []<-chan Event{a, b} {
		e := receive(t, ch)
		if e.Type != TypeKeyUse || e.Cell != "c1" || e.Time.IsZero() {
			t.Fatalf("event %+v", e)
		}
	}
}

func TestCancelClosesTheChannel(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(1)
	cancel()
	cancel()
	if _, ok := <-ch; ok {
		t.Fatal("channel still open")
	}
	h.Publish(Event{Type: TypeKeyUse})
}

func TestASlowSubscriberDropsAndIsToldHowMany(t *testing.T) {
	h := NewHub()
	ch, cancel := h.Subscribe(1)
	defer cancel()
	done := make(chan struct{})
	go func() {
		for range 5 {
			h.Publish(Event{Type: TypeKeyUse})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Publish blocked on a full subscriber")
	}
	first := receive(t, ch)
	if first.Type != TypeKeyUse {
		t.Fatalf("first event %+v", first)
	}
	h.Publish(Event{Type: TypeKeyUse})
	next := receive(t, ch)
	if next.Type != TypeDropped || next.Data.(Dropped).Count != 4 {
		t.Fatalf("next event %+v, want a dropped notice for 4", next)
	}
}
```

- [ ] **Step 2: Run them to see them fail**

Run: `go test ./internal/audit/ ./internal/events/`
Expected: FAIL — both packages `[build failed]`: `undefined: Log` and `undefined: Open` in audit,
`undefined: Event` in events.

- [ ] **Step 3: Implement the log and the hub**

`keyd/internal/audit/audit.go`:
```go
// Package audit writes keyd's decision log: one JSON line per decision, each line carrying the
// SHA-256 of the line before it, so an edit, a deletion or a reordering breaks the chain.
package audit

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/shadowhusky/localdot/keyd/internal/surrogate"
)

const (
	KindConnect = "connect"
	KindRequest = "request"
	KindAdmin   = "admin"
	KindKeyd    = "keyd"

	Allow = "allow"
	Deny  = "deny"
	Error = "error"
)

const (
	maxDetail  = 512
	tailWindow = 64 * 1024
)

var genesis = strings.Repeat("0", 64)

// Line never carries a secret value or a surrogate; SurrogateID names a surrogate instead, and
// Write turns surrogate-shaped text in the fields a request controls into surrogate:<ID>.
type Line struct {
	V            int     `json:"v"`
	Seq          uint64  `json:"seq"`
	Time         string  `json:"time"`
	Kind         string  `json:"kind"`
	Cell         string  `json:"cell,omitempty"`
	Port         int     `json:"port,omitempty"`
	Mode         string  `json:"mode,omitempty"`
	Method       string  `json:"method,omitempty"`
	Host         string  `json:"host,omitempty"`
	Path         string  `json:"path,omitempty"`
	SNI          string  `json:"sni,omitempty"`
	Route        string  `json:"route,omitempty"`
	Model        string  `json:"model,omitempty"`
	Status       int     `json:"status,omitempty"`
	BytesIn      int64   `json:"bytesIn,omitempty"`
	BytesOut     int64   `json:"bytesOut,omitempty"`
	DurationMs   float64 `json:"durationMs,omitempty"`
	Decision     string  `json:"decision"`
	Reason       string  `json:"reason,omitempty"`
	SecretID     string  `json:"secretId,omitempty"`
	SurrogateID  string  `json:"surrogateId,omitempty"`
	Swapped      bool    `json:"swapped,omitempty"`
	CostMicroUSD int64   `json:"costMicroUSD,omitempty"`
	Usage        string  `json:"usage,omitempty"`
	Detail       string  `json:"detail,omitempty"`
	Prev         string  `json:"prev"`
}

// file is what Log needs of *os.File; tests put a failing one in its place.
type file interface {
	io.Writer
	io.ReaderAt
	Stat() (os.FileInfo, error)
	Truncate(size int64) error
	Close() error
}

type Log struct {
	mu   sync.Mutex
	f    file
	size int64
	seq  uint64
	prev string
	err  error
	now  func() time.Time
	hook func(Line)
}

// Open appends to path, resuming the chain from its last line. A partial last line, left by a
// crash mid-write, is cut off and the repair is itself recorded.
func Open(path string) (*Log, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, err
	}
	l := &Log{f: f, prev: genesis, now: time.Now}
	partial, err := l.resume()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("audit %s: %w", path, err)
	}
	if partial > 0 {
		if _, err := l.Write(Line{Kind: KindKeyd, Decision: Error, Reason: "audit-repair", BytesIn: partial, Detail: "dropped a partial last line"}); err != nil {
			f.Close()
			return nil, err
		}
	}
	return l, nil
}

func (l *Log) resume() (int64, error) {
	info, err := l.f.Stat()
	if err != nil {
		return 0, err
	}
	size := info.Size()
	start := max(0, size-tailWindow)
	tail := make([]byte, size-start)
	if _, err := l.f.ReadAt(tail, start); err != nil && err != io.EOF {
		return 0, err
	}
	end := bytes.LastIndexByte(tail, '\n') + 1
	partial := int64(len(tail) - end)
	l.size = start + int64(end)
	if partial > 0 {
		if err := l.f.Truncate(l.size); err != nil {
			return 0, err
		}
	}
	if end == 0 {
		if start > 0 {
			return 0, fmt.Errorf("no line end in the last %d bytes", tailWindow)
		}
		return partial, nil
	}
	last := tail[bytes.LastIndexByte(tail[:end-1], '\n')+1 : end-1]
	var line Line
	if err := json.Unmarshal(last, &line); err != nil {
		return 0, fmt.Errorf("last line: %w", err)
	}
	sum := sha256.Sum256(last)
	l.seq, l.prev = line.Seq, hex.EncodeToString(sum[:])
	return partial, nil
}

// OnWrite registers a function called after each line is written.
func (l *Log) OnWrite(fn func(Line)) {
	l.mu.Lock()
	l.hook = fn
	l.mu.Unlock()
}

// Write appends the line and returns it as written, also when it fails. A failed write is kept as
// Err until a later write succeeds, and the bytes it left are cut off first, so a partial line
// never sits inside the chain.
func (l *Log) Write(line Line) (Line, error) {
	line = redact(line)
	l.mu.Lock()
	line.V, line.Seq, line.Prev = 1, l.seq+1, l.prev
	line.Time = l.now().UTC().Format(time.RFC3339Nano)
	if len(line.Detail) > maxDetail {
		line.Detail = line.Detail[:maxDetail]
	}
	raw, err := json.Marshal(line)
	if err == nil {
		err = l.append(raw)
	}
	l.err = err
	if err != nil {
		l.mu.Unlock()
		return line, err
	}
	sum := sha256.Sum256(raw)
	l.seq, l.prev = line.Seq, hex.EncodeToString(sum[:])
	hook := l.hook
	l.mu.Unlock()
	if hook != nil {
		hook(line)
	}
	return line, nil
}

func (l *Log) append(raw []byte) error {
	if l.err != nil {
		if err := l.f.Truncate(l.size); err != nil {
			return err
		}
	}
	n, err := l.f.Write(append(raw, '\n'))
	if err != nil {
		return err
	}
	l.size += int64(n)
	return nil
}

// Err is the last write's error, or nil once a write has succeeded again. keyd swaps no secret
// while it is set: a use of the secret would go unrecorded.
func (l *Log) Err() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.err
}

func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.f.Close()
}

// redact writes each surrogate-shaped token in the fields a request controls as surrogate:<ID>.
func redact(l Line) Line {
	for _, field := range []*string{&l.Method, &l.Host, &l.Path, &l.SNI, &l.Route, &l.Model, &l.Detail} {
		for _, tok := range surrogate.Find(*field) {
			*field = strings.ReplaceAll(*field, tok, "surrogate:"+surrogate.ID(tok))
		}
	}
	return l
}

// Verify checks the chain and the sequence numbers and returns how many lines are intact.
func Verify(r io.Reader) (int, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	prev, seq, n := genesis, uint64(0), 0
	for sc.Scan() {
		raw := sc.Bytes()
		var line struct {
			Seq  uint64 `json:"seq"`
			Prev string `json:"prev"`
		}
		if err := json.Unmarshal(raw, &line); err != nil {
			return n, fmt.Errorf("audit line %d: %w", n+1, err)
		}
		if line.Prev != prev {
			return n, fmt.Errorf("audit line %d: chain broken", n+1)
		}
		if line.Seq != seq+1 {
			return n, fmt.Errorf("audit line %d: seq %d after %d", n+1, line.Seq, seq)
		}
		sum := sha256.Sum256(raw)
		prev, seq, n = hex.EncodeToString(sum[:]), line.Seq, n+1
	}
	return n, sc.Err()
}
```

`keyd/internal/events/events.go`:
```go
// Package events fans keyd's notices out to admin-socket subscribers, best effort: the audit log
// is the durable record, and a subscriber that falls behind is told how many events it missed.
package events

import (
	"sync"
	"time"
)

const (
	TypeKeyUse  = "key.use"
	TypeBudget  = "budget.exceeded"
	TypeDropped = "events.dropped"
)

type Event struct {
	Type string    `json:"type"`
	Cell string    `json:"cell,omitempty"`
	Time time.Time `json:"time"`
	Data any       `json:"data,omitempty"`
}

// KeyUse is the data of @localdot/protocol's key.use event.
type KeyUse struct {
	SecretID string `json:"secretId"`
	Host     string `json:"host"`
	Method   string `json:"method"`
	Path     string `json:"path"`
	Decision string `json:"decision"`
}

type Budget struct {
	Scope    string  `json:"scope"`
	TaskID   string  `json:"taskId,omitempty"`
	LimitUSD float64 `json:"limitUSD"`
	SpentUSD float64 `json:"spentUSD"`
}

type Dropped struct {
	Count int `json:"count"`
}

type subscriber struct {
	ch      chan Event
	dropped int
}

type Hub struct {
	mu   sync.Mutex
	subs map[*subscriber]struct{}
}

func NewHub() *Hub {
	return &Hub{subs: map[*subscriber]struct{}{}}
}

// Subscribe returns a channel with room for buf events and a cancel that closes it.
func (h *Hub) Subscribe(buf int) (<-chan Event, func()) {
	s := &subscriber{ch: make(chan Event, buf)}
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
	var once sync.Once
	return s.ch, func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, s)
			close(s.ch)
			h.mu.Unlock()
		})
	}
}

// Publish never blocks.
func (h *Hub) Publish(e Event) {
	if e.Time.IsZero() {
		e.Time = time.Now().UTC()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for s := range h.subs {
		if s.dropped > 0 {
			select {
			case s.ch <- Event{Type: TypeDropped, Time: e.Time, Data: Dropped{Count: s.dropped}}:
				s.dropped = 0
			default:
				s.dropped++
				continue
			}
		}
		select {
		case s.ch <- e:
		default:
			s.dropped++
		}
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `go test -race ./internal/audit/ ./internal/events/`
Expected: `ok` for both (8 and 3 tests).

- [ ] **Step 5: Format, vet, commit**

```bash
test -z "$(gofmt -l .)" && go vet ./...
git add internal/audit internal/events
git commit -m "feat(keyd): hash-chained audit log and event hub"
```

---
