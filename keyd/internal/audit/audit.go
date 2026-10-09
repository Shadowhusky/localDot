// Package audit writes keyd's decision log: one JSON line per decision, each line carrying the
// SHA-256 of the line before it, so an edit, a deletion or a reordering breaks the chain.
package audit

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
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

// clock stamps the lines a new Log writes and the name of a log set aside; tests fix it.
var clock = time.Now

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
	DestPort     int     `json:"destPort,omitempty"`
	Via          string  `json:"via,omitempty"`
	App          string  `json:"app,omitempty"`
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

// file is what Log needs of *os.File; tests put a failing one in its place. Log writes at the end it
// tracks, not in append mode, so a repair line can take a partial line's place before it is cut.
type file interface {
	io.Writer
	io.Seeker
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

// Open appends to path, resuming the chain from its last line. A partial last line, left by a crash
// mid-write, is overwritten by a line recording the repair; if that line cannot be written, the
// partial line stays for the next start. A log Open cannot resume, with no line end within reach or
// a last line that is not JSON, is renamed aside byte for byte as <path>.damaged-<UTC time>, and a
// new chain starts whose first line names it.
func Open(path string) (*Log, error) {
	f, err := openFile(path, os.O_RDWR|os.O_CREATE)
	if err != nil {
		return nil, err
	}
	return start(path, f)
}

// openFile opens the log's file as keyd's alone, 0600 whatever the umask or an older mode.
func openFile(path string, flag int) (*os.File, error) {
	f, err := os.OpenFile(path, flag, 0o600)
	if err != nil {
		return nil, err
	}
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// start resumes the log in f as Open describes; tests hand it a failing file.
func start(path string, f file) (*Log, error) {
	l := &Log{f: f, prev: genesis, now: clock}
	partial, damage, err := l.resume()
	if err == nil && damage != "" {
		f.Close()
		return rotate(path, damage)
	}
	if err == nil && partial > 0 {
		err = l.repair(partial)
	}
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("audit %s: %w", path, err)
	}
	return l, nil
}

// resume reads the chain's end from the last line. It reports a log it cannot read as damage, and a
// partial last line by its length; it changes neither.
func (l *Log) resume() (partial int64, damage string, err error) {
	info, err := l.f.Stat()
	if err != nil {
		return 0, "", err
	}
	size := info.Size()
	from := max(0, size-tailWindow)
	tail := make([]byte, size-from)
	if _, err := l.f.ReadAt(tail, from); err != nil && err != io.EOF {
		return 0, "", err
	}
	end := bytes.LastIndexByte(tail, '\n') + 1
	if end == 0 && from > 0 {
		return 0, fmt.Sprintf("no line end in the last %d bytes", tailWindow), nil
	}
	if end > 0 {
		last := tail[bytes.LastIndexByte(tail[:end-1], '\n')+1 : end-1]
		var line Line
		if err := json.Unmarshal(last, &line); err != nil {
			return 0, "last line: " + err.Error(), nil
		}
		sum := sha256.Sum256(last)
		l.seq, l.prev = line.Seq, hex.EncodeToString(sum[:])
	}
	l.size = from + int64(end)
	return int64(len(tail) - end), "", nil
}

// repair writes the line recording a partial last line over it, then cuts what is left of it, so a
// repair line that cannot be written leaves the partial line for the next start.
func (l *Log) repair(partial int64) error {
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Error, Reason: "audit-repair", BytesIn: partial, Detail: "dropped a partial last line"}); err != nil {
		return err
	}
	return l.f.Truncate(l.size)
}

// rotate sets aside a log Open cannot resume and starts a new chain whose first line names it, with
// its size, its SHA-256 and why. Only a failed rename or new file stops keyd. The keyd lock keeps
// every other process away, so a name checked free is still free when the rename uses it.
func rotate(path, damage string) (*Log, error) {
	sum, size, err := hashFile(path)
	if err != nil {
		return nil, fmt.Errorf("audit %s: %w", path, err)
	}
	aside := path + ".damaged-" + clock().UTC().Format("20060102T150405.000000000Z")
	if _, err := os.Lstat(aside); !errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("audit %s: cannot set it aside: %s exists", path, aside)
	}
	if err := os.Rename(path, aside); err != nil {
		return nil, fmt.Errorf("audit %s: %w", path, err)
	}
	f, err := openFile(path, os.O_RDWR|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return nil, fmt.Errorf("audit %s: %w", path, err)
	}
	l := &Log{f: f, prev: genesis, now: clock}
	name := filepath.Base(aside)
	if _, err := l.Write(Line{Kind: KindKeyd, Decision: Error, Reason: "audit-rotated", BytesIn: size, Detail: name + " sha256:" + sum + ": " + damage}); err != nil {
		f.Close()
		return nil, fmt.Errorf("audit %s: %w", path, err)
	}
	log.Printf("keyd: audit log %s could not be resumed (%s); it is set aside as %s and a new chain begins", path, damage, name)
	return l, nil
}

func hashFile(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
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
	if _, err := l.f.Seek(l.size, io.SeekStart); err != nil {
		return err
	}
	n, err := l.f.Write(append(raw, '\n'))
	if err != nil {
		return err
	}
	l.size += int64(n)
	return nil
}

// Err is the last write's error, or ErrClosed after retirement. keyd swaps no secret
// while it is set: a use of the secret would go unrecorded.
func (l *Log) Err() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.err
}

func (l *Log) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	// Publish unavailability while holding the same lock as Err and Write. Otherwise a
	// fresh credential request can pass its audit readiness check after the file closed.
	l.err = os.ErrClosed
	return l.f.Close()
}

// redact rewrites and caps every text field but Time and Prev, which are Write's own. It cuts after
// rewriting, so a cut never leaves part of a token unrewritten.
func redact(l Line) Line {
	for _, field := range []*string{&l.Kind, &l.Cell, &l.Mode, &l.Method, &l.Host, &l.Path, &l.SNI, &l.Via, &l.App,
		&l.Route, &l.Model, &l.Decision, &l.Reason, &l.SecretID, &l.SurrogateID, &l.Usage} {
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
