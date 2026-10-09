package main

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/shadowhusky/localdot/keyd/internal/audit"
)

type adoptResult struct {
	moved, failed int
	err           error
}

func (a adoptResult) Adopt() (int, int, error) { return a.moved, a.failed, a.err }

// The audit names every item adopt could not move, which stays readable by an earlier keyd until a
// later start moves it.
func TestAdoptAuditCountsTheItemsItCouldNotMove(t *testing.T) {
	for _, test := range []struct {
		result   adoptResult
		decision string
		detail   string
	}{
		{adoptResult{}, "", ""},
		{adoptResult{moved: 3}, audit.Allow, "3 items moved from an earlier keyd"},
		{adoptResult{moved: 3, failed: 2}, audit.Deny, "3 items moved from an earlier keyd, 2 could not be moved"},
		{adoptResult{failed: 1}, audit.Deny, "0 items moved from an earlier keyd, 1 could not be moved"},
		{adoptResult{err: errors.New("no listing")}, audit.Deny, "items from an earlier keyd were not all moved"},
	} {
		log, err := audit.Open(filepath.Join(t.TempDir(), "audit.jsonl"))
		if err != nil {
			t.Fatal(err)
		}
		var lines []audit.Line
		log.OnWrite(func(line audit.Line) { lines = append(lines, line) })
		if err := (&Daemon{log: log}).adopt(test.result); err != nil {
			t.Fatal(err)
		}
		log.Close()
		switch {
		case test.decision == "" && len(lines) != 0:
			t.Fatalf("%+v wrote %+v", test.result, lines)
		case test.decision != "" && (len(lines) != 1 || lines[0].Reason != "adopt" ||
			lines[0].Decision != test.decision || lines[0].Detail != test.detail):
			t.Fatalf("%+v wrote %+v", test.result, lines)
		}
	}
}
