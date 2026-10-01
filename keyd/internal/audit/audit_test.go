package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"slices"
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
	named := "[surrogate:" + surrogate.ID(tok) + "]"
	if strings.Contains(string(data), tok) || strings.Contains(hooked.Path+hooked.Host+hooked.Detail, tok) || line.Path != "/keys/"+named || line.Host != named+".example.test" {
		t.Fatalf("written %s; returned %+v", data, line)
	}
}

func TestOverlappingSurrogatesAreWrittenAsOneSpan(t *testing.T) {
	mint := func(tag string) string {
		tok, err := surrogate.Mint(tag)
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	tok, other, hidden := mint("ant"), mint("key"), mint("hiddenbehind")
	endsInLD := mint("oai")
	for tries := 1; !strings.HasSuffix(endsInLD, "ld"); tries++ {
		if tries == 1_000_000 {
			t.Fatal("no surrogate's checksum ends in ld")
		}
		endsInLD = mint("oai")
	}
	body := func() string { return mint("xx")[6:28] }
	b1, b2, b20 := body(), body(), body()[:20]
	forged1, forged2 := "ld_xx_"+b1+"_Ab3Dld", "ld_yy_"+b2+"_Ef5Gld"
	cases := []struct {
		name   string
		text   string
		tokens []string
	}{
		{"two surrogates sharing ld", endsInLD + tok[2:], []string{endsInLD, tok}},
		{"a checksum ending on a surrogate's l", "ld_xx_" + b1 + "_Ab3DE" + tok, []string{"ld_xx_" + b1 + "_Ab3DEl", tok}},
		{"a body ending on a surrogate's ld", "ld_xx_" + b20 + hidden, []string{"ld_xx_" + b20 + hidden[:9], hidden}},
		{"a chain of three", forged1[:33] + forged2[:33] + tok, []string{forged1, forged2, tok}},
		{"two surrogates side by side", tok + other, []string{tok, other}},
	}
	for _, c := range cases {
		l, path := openLog(t)
		var hooked Line
		l.OnWrite(func(line Line) { hooked = line })
		line, err := l.Write(Line{Kind: KindRequest, Path: "/keys/" + c.text + "/x", Detail: "lookup " + c.text, Decision: Deny})
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, len(c.tokens))
		for i, tok := range c.tokens {
			ids[i] = surrogate.ID(tok)
		}
		named := "[surrogate:" + strings.Join(ids, ",") + "]"
		if line.Path != "/keys/"+named+"/x" || line.Detail != "lookup "+named || hooked != line {
			t.Errorf("%s: returned %+v, hooked %+v", c.name, line, hooked)
		}
		data, _ := os.ReadFile(path)
		if len(surrogate.Find(string(data))) > 0 {
			t.Errorf("%s: token-shaped text survives: %s", c.name, data)
		}
		for _, tok := range c.tokens {
			body, sum := tok[len(tok)-29:len(tok)-7], tok[len(tok)-6:]
			if bytes.Contains(data, []byte(body)) || bytes.Contains(data, []byte(sum)) {
				t.Errorf("%s: the body or checksum of %s survives: %s", c.name, tok, data)
			}
		}
	}
}

// textFields names Line's text fields that Write takes from its caller; Time and Prev are its own.
func textFields(t *testing.T) []string {
	t.Helper()
	var names []string
	typ := reflect.TypeFor[Line]()
	for i := range typ.NumField() {
		if f := typ.Field(i); f.Type.Kind() == reflect.String && f.Name != "Time" && f.Name != "Prev" {
			names = append(names, f.Name)
		}
	}
	if len(names) != 15 {
		t.Fatalf("Line has %d text fields, want 15: %v", len(names), names)
	}
	return names
}

func withField(name, value string) Line {
	var line Line
	reflect.ValueOf(&line).Elem().FieldByName(name).SetString(value)
	return line
}

func field(line Line, name string) string {
	return reflect.ValueOf(line).FieldByName(name).String()
}

func TestEveryTextFieldIsRedacted(t *testing.T) {
	l, path := openLog(t)
	tok, _ := surrogate.Mint("key")
	named := "[surrogate:" + surrogate.ID(tok) + "]"
	for _, name := range textFields(t) {
		line, err := l.Write(withField(name, "x"+tok+"y"))
		if err != nil {
			t.Fatal(err)
		}
		if got := field(line, name); got != "x"+named+"y" {
			t.Errorf("%s written as %q", name, got)
		}
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), tok) {
		t.Errorf("the surrogate reached the file: %s", data)
	}
}

func TestARewriteNeverCompletesATokenShape(t *testing.T) {
	l, path := openLog(t)
	tok, _ := surrogate.Mint("key")
	named := "[surrogate:" + surrogate.ID(tok) + "]"
	// With four or five checksum characters, the token's "ld" or "l" completes the run itself: an overlap.
	for _, checksum := range []string{"", "0", "01", "012"} {
		before := "/k/ld_ab_" + strings.Repeat("Q", 22) + "_" + checksum
		line, err := l.Write(Line{Kind: KindRequest, Path: before + tok + "/x", Decision: Deny})
		if err != nil {
			t.Fatal(err)
		}
		if line.Path != before+named+"/x" {
			t.Errorf("%q written as %q", before+tok, line.Path)
		}
	}
	data, _ := os.ReadFile(path)
	if found := surrogate.Find(string(data)); len(found) > 0 {
		t.Errorf("a rewrite completed the token shapes %q", found)
	}
}

func TestTextFieldsAreCappedAtFixedLengths(t *testing.T) {
	l, _ := openLog(t)
	tok, _ := surrogate.Mint("key")
	for _, name := range textFields(t) {
		limit := 2048
		if name == "Detail" {
			limit = 512
		}
		for _, n := range []int{limit, limit + 1, 1 << 20} {
			value := strings.Repeat("a", n)
			line, err := l.Write(withField(name, value))
			if err != nil {
				t.Fatal(err)
			}
			want := value
			if n > limit {
				want = value[:limit-len("…")] + "…"
			}
			if got := field(line, name); got != want {
				t.Errorf("%s of %d bytes written as %d bytes ending %q", name, n, len(got), got[max(0, len(got)-4):])
			}
		}
		line, err := l.Write(withField(name, strings.Repeat("a", limit-30)+tok))
		if err != nil {
			t.Fatal(err)
		}
		if got := field(line, name); strings.Contains(got, tok[:12]) {
			t.Errorf("%s: a surrogate across the cap was cut before it was rewritten: %q", name, got[len(got)-40:])
		}
	}
}

func TestAOneMiBPathIsCappedAndTheLogStillOpens(t *testing.T) {
	l, path := openLog(t)
	line, err := l.Write(Line{Kind: KindRequest, Method: "GET", Host: "h.example.test", Path: "/" + strings.Repeat("a", 1<<20), Decision: Allow})
	if err != nil {
		t.Fatal(err)
	}
	if len(line.Path) != 2048 || !strings.HasSuffix(line.Path, "…") {
		t.Fatalf("a 1 MiB path written as %d bytes", len(line.Path))
	}
	l.Close()
	again, err := Open(path)
	if err != nil {
		t.Fatalf("Open after a 1 MiB path: %v", err)
	}
	defer again.Close()
	if _, err := again.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 2 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
}

func TestTheLongestLinesReopenAndVerify(t *testing.T) {
	l, path := openLog(t)
	var longest Line
	v := reflect.ValueOf(&longest).Elem()
	for _, name := range textFields(t) {
		v.FieldByName(name).SetString(strings.Repeat("<", 4096)) // JSON writes each as <
	}
	longest.Port, longest.Status = math.MinInt, math.MinInt
	longest.BytesIn, longest.BytesOut, longest.CostMicroUSD = math.MinInt64, math.MinInt64, math.MinInt64
	longest.DurationMs, longest.Swapped = -math.MaxFloat64, true
	for range 3 {
		if _, err := l.Write(longest); err != nil {
			t.Fatal(err)
		}
	}
	l.Close()
	all := lines(t, path)
	for _, raw := range all {
		if len(raw)+1 > 256<<10 {
			t.Fatalf("a %d-byte line", len(raw)+1)
		}
	}
	t.Logf("the longest line is %d bytes", len(all[0])+1)
	// A crash just before the next line's newline leaves the longest partial line there can be.
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.Write(all[2])
	f.Close()
	again, err := Open(path)
	if err != nil {
		t.Fatalf("Open after the longest lines: %v", err)
	}
	again.Close()
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 4 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
}

func TestVerifyCatchesAControlCharacterInAnyLine(t *testing.T) {
	l, path := openLog(t)
	for range 3 {
		if _, err := l.Write(Line{Kind: KindRequest, Decision: Allow}); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(path)
	if n, err := Verify(bytes.NewReader(data)); err != nil || n != 3 {
		t.Fatalf("Verify = %d, %v", n, err)
	}
	newest := bytes.LastIndexByte(data[:len(data)-1], '\n') + 1
	for name, bad := range map[string][]byte{
		"a CR ending the first line":   bytes.Replace(data, []byte("}\n"), []byte("}\r\n"), 1),
		"a CR ending the newest line":  append(bytes.Clone(data[:len(data)-1]), "\r\n"...),
		"a tab inside the newest line": slices.Concat(data[:newest+1], []byte("\t"), data[newest+1:]),
	} {
		if n, err := Verify(bytes.NewReader(bad)); err == nil {
			t.Errorf("%s: Verify = %d, nil", name, n)
		}
	}
}

func TestOpenLeavesALogItCannotResumeUncut(t *testing.T) {
	for name, tail := range map[string]string{
		"no line end within reach": strings.Repeat("a", 4<<20),
		"an unreadable last line":  "not json\npartial",
	} {
		path := filepath.Join(t.TempDir(), "audit.jsonl")
		l, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := l.Write(Line{Kind: KindKeyd, Decision: Allow, Reason: "start"}); err != nil {
			t.Fatal(err)
		}
		l.Close()
		f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
		f.WriteString(tail)
		f.Close()
		before, _ := os.ReadFile(path)
		if again, err := Open(path); err == nil {
			again.Close()
			t.Errorf("%s: Open succeeded", name)
		}
		if after, _ := os.ReadFile(path); !bytes.Equal(after, before) {
			t.Errorf("%s: Open cut %d bytes before refusing", name, len(before)-len(after))
		}
	}
}
