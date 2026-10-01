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
	maxField  = 2048
	maxDetail = 512
	cutMark   = "…"
	// No line Write produces, newline included, is longer: every text field is capped, and JSON
	// writes a byte as at most six (\u00XX).
	maxLine = 256 << 10
	// Open reads enough to hold the last line and the partial line a crash can leave after it.
	tailWindow = 2 * maxLine
)

var genesis = strings.Repeat("0", 64)

// Line never carries a secret value or a surrogate; SurrogateID names a surrogate instead. Write
// treats every text field as the request's: it writes surrogate-shaped text as [surrogate:<ID>]
// and cuts each field to 2 KiB, Detail to 512 bytes, ending a cut field in "…".
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
	if end == 0 && start > 0 {
		return 0, fmt.Errorf("no line end in the last %d bytes", tailWindow)
	}
	if end > 0 {
		last := tail[bytes.LastIndexByte(tail[:end-1], '\n')+1 : end-1]
		var line Line
		if err := json.Unmarshal(last, &line); err != nil {
			return 0, fmt.Errorf("last line: %w", err)
		}
		sum := sha256.Sum256(last)
		l.seq, l.prev = line.Seq, hex.EncodeToString(sum[:])
	}
	partial := int64(len(tail) - end)
	l.size = start + int64(end)
	if partial > 0 {
		if err := l.f.Truncate(l.size); err != nil {
			return 0, err
		}
	}
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

// redact rewrites and caps every text field but Time and Prev, which are Write's own. It cuts after
// rewriting, so a cut never leaves part of a token unrewritten.
func redact(l Line) Line {
	for _, field := range []*string{&l.Kind, &l.Cell, &l.Mode, &l.Method, &l.Host, &l.Path, &l.SNI, &l.Route,
		&l.Model, &l.Decision, &l.Reason, &l.SecretID, &l.SurrogateID, &l.Usage} {
		*field = clip(redactText(*field), maxField)
	}
	l.Detail = clip(redactText(l.Detail), maxDetail)
	return l
}

// redactText writes each run of overlapping or touching token-shaped spans once, as
// [surrogate:<ID>], or [surrogate:<ID>,<ID>] naming the run's tokens in start order. Rewriting token
// by token would let one token's ID take the start of a token overlapping it and leave the rest, its
// random body and checksum, in the line. The brackets are outside the token alphabet, so a rewrite
// cannot complete a token shape with the text beside it.
func redactText(s string) string {
	spans := surrogate.FindIndex(s)
	if len(spans) == 0 {
		return s
	}
	var b strings.Builder
	done := 0
	for i := 0; i < len(spans); {
		start, end := spans[i][0], spans[i][1]
		var ids []string
		for ; i < len(spans) && spans[i][0] <= end; i++ {
			ids = append(ids, surrogate.ID(s[spans[i][0]:spans[i][1]]))
			end = max(end, spans[i][1])
		}
		b.WriteString(s[done:start])
		b.WriteString("[surrogate:" + strings.Join(ids, ",") + "]")
		done = end
	}
	b.WriteString(s[done:])
	return b.String()
}

// clip cuts s to at most n bytes, ending a cut in cutMark.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-len(cutMark)] + cutMark
}

// Verify checks the chain and the sequence numbers and returns how many lines are intact. It
// hashes each line exactly as stored, so a change to a line breaks the chain at the next one. Write
// never writes a control character (JSON escapes them), so one is an edit even in the newest line,
// which no later line vouches for.
func Verify(r io.Reader) (int, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), maxLine)
	sc.Split(splitLines)
	prev, seq, n := genesis, uint64(0), 0
	for sc.Scan() {
		raw := sc.Bytes()
		if i := bytes.IndexFunc(raw, func(r rune) bool { return r < ' ' }); i >= 0 {
			return n, fmt.Errorf("audit line %d: control character at byte %d", n+1, i)
		}
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

// splitLines splits at each newline and, unlike bufio.ScanLines, keeps a carriage return before it.
func splitLines(data []byte, atEOF bool) (int, []byte, error) {
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}
