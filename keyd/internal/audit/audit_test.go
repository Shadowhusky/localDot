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
