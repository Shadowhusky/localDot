package vault

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// BindingsMarkerID names the Keychain item in which keyd records its one migration of the values a
// keyd from before bindings stored. No user secret may take it.
const BindingsMarkerID = "keyd-bindings"

const (
	markerPrefix  = "keyd-bindings:1:"
	markerRunning = "running"
	markerDone    = "done"
	// markerForeign is a marker keyd did not write; it keeps the migration closed for good.
	markerForeign = "foreign"
)

var legacyHeadPattern = regexp.MustCompile(`^keyd:([0-9a-f]{16}):([1-9][0-9]*)$`)

// Migration is what one pass over the stored values found.
type Migration struct {
	// Bound lists the values this pass bound to their records.
	Bound []string
	// Reenter lists the records whose stored values are gone or can never be read as stored.
	Reenter []string
	// Done reports that the migration is recorded as finished; it never runs again.
	Done bool
}

type itemState int

const (
	itemReadable itemState = iota
	itemReenter
	itemUnknown
)

// MigrateBindings binds, once, each value an earlier keyd stored without its binding to the record
// the index held for it, and names the records whose values can never be read as they are stored.
//
// Every keyd binary from before bindings reads an unbound item for whatever index it is given, so
// binding the items keyd wrote closes that, and binds each one to where keyd was already sending
// it. A bound item is never touched. The proof that keyd wrote an item is keyd's own: the marker,
// a Keychain item only signed keyd can read, records when the migration began; only an item laid
// out exactly as keyd lays one out, under a record the index held from before then, is bound.
// Every other unbound item stays refused until its value is stored again. The marker is written
// before the first item and marked done after the last, so a migration cut short resumes from the
// same moment, and a finished one never runs again. Binding rewrites the item head alone, in one
// write, leaving the chunks as they are: a crash leaves the item unbound, for the next start to
// bind, or bound.
func (k *Keychain) MigrateBindings(records []Record, now time.Time) Migration {
	began, state := k.beginMigration(now)
	m := Migration{Done: state == markerDone}
	complete := true
	for _, rec := range records {
		if !Writable(rec.ID) {
			continue
		}
		switch item, bound := k.settle(rec, began, state); {
		case item == itemReenter:
			m.Reenter = append(m.Reenter, rec.ID)
		case item == itemUnknown:
			complete = false
		case bound:
			m.Bound = append(m.Bound, rec.ID)
		}
	}
	if state == markerRunning && complete {
		m.Done = k.endMigration(began)
	}
	return m
}

// beginMigration reads the marker, writing it on the first start that finds none, and returns when
// the migration began and its state; no state while the Keychain cannot say.
func (k *Keychain) beginMigration(now time.Time) (time.Time, string) {
	ctx, cancel := k.deadline()
	defer cancel()
	data, err := k.find(ctx, BindingsMarkerID)
	if errors.Is(err, ErrNotFound) {
		if err := k.add(ctx, BindingsMarkerID, markerText(markerRunning, now)); err != nil {
			log.Printf("keyd: the binding migration could not begin: %v", err)
			return time.Time{}, ""
		}
		return now, markerRunning
	}
	if err != nil {
		log.Printf("keyd: the binding migration marker could not be read: %v", err)
		return time.Time{}, ""
	}
	state, began, ok := parseMarker(data)
	if !ok {
		log.Printf("keyd: the binding migration marker is not keyd's")
		return time.Time{}, markerForeign
	}
	return began, state
}

func (k *Keychain) endMigration(began time.Time) bool {
	ctx, cancel := k.deadline()
	defer cancel()
	if err := k.add(ctx, BindingsMarkerID, markerText(markerDone, began)); err != nil {
		log.Printf("keyd: the binding migration could not be recorded as done: %v", err)
		return false
	}
	return true
}

// settle classifies rec's stored value and, while the migration runs, binds it if keyd can prove it
// wrote it. An error that may pass, such as a locked Keychain or a helper that timed out, leaves
// the state unknown.
func (k *Keychain) settle(rec Record, began time.Time, migration string) (itemState, bool) {
	ctx, cancel := k.deadline()
	defer cancel()
	head, err := k.find(ctx, rec.ID)
	switch {
	case errors.Is(err, ErrNotFound):
		return itemReenter, false
	case err != nil:
		return itemUnknown, false
	}
	binding := bindingOf(rec)
	_, _, bound, ok := parseHead(head)
	switch {
	case ok && bound == binding:
		return itemReadable, false
	case ok && bound == "" && migration == "":
		return itemUnknown, false
	case !ok || bound != "" || migration != markerRunning || !keptBefore(rec, began):
		return itemReenter, false
	}
	match := legacyHeadPattern.FindStringSubmatch(head)
	if match == nil {
		return itemReenter, false
	}
	gen := match[1]
	count, err := strconv.Atoi(match[2])
	if err != nil || count > maxChunks {
		return itemReenter, false
	}
	if state := k.checkLegacyChunks(ctx, rec.ID, gen, count); state != itemReadable {
		return state, false
	}
	next := itemHead(gen, count, binding)
	if err := k.add(ctx, rec.ID, next); err != nil {
		log.Printf("keyd: secret %s could not be bound: %v", rec.ID, err)
		return itemUnknown, false
	}
	if got, err := k.find(ctx, rec.ID); err != nil || got != next {
		return itemUnknown, false
	}
	return itemReadable, true
}

// checkLegacyChunks reads an unbound item's chunks and holds them to the layout keyd writes: each
// chunk is the write's generation and the part's lower-case hex, every part but the last is full,
// and together they are a value keyd would have stored.
func (k *Keychain) checkLegacyChunks(ctx context.Context, id, gen string, count int) itemState {
	// Every part fits the capacity, so the value never moves and is cleared whole.
	value := make([]byte, 0, count*chunkBytes)
	defer func() { clear(value[:cap(value)]) }()
	for i := range count {
		data, err := k.find(ctx, chunkAccount(id, i))
		switch {
		case errors.Is(err, ErrNotFound):
			return itemReenter
		case err != nil:
			return itemUnknown
		}
		g, encoded, _ := strings.Cut(data, ":")
		part, derr := hex.DecodeString(encoded)
		laid := g == gen && derr == nil && hex.EncodeToString(part) == encoded && len(part) > 0 &&
			(len(part) == chunkBytes || (i == count-1 && len(part) < chunkBytes))
		if laid {
			value = append(value, part...)
		}
		clear(part)
		if !laid {
			return itemReenter
		}
	}
	if ValidValue(value) != nil {
		return itemReenter
	}
	return itemReadable
}

// keptBefore reports whether the index held rec, timed as keyd times a record, before began.
func keptBefore(rec Record, began time.Time) bool {
	return !rec.UpdatedAt.IsZero() && !rec.CreatedAt.After(rec.UpdatedAt) && !rec.UpdatedAt.After(began)
}

func markerText(state string, began time.Time) string {
	return fmt.Sprintf("%s%s:%d", markerPrefix, state, began.UnixNano())
}

func parseMarker(data string) (string, time.Time, bool) {
	rest, ok := strings.CutPrefix(data, markerPrefix)
	state, nanos, cut := strings.Cut(rest, ":")
	n, err := strconv.ParseInt(nanos, 10, 64)
	if !ok || !cut || err != nil || n <= 0 || (state != markerRunning && state != markerDone) {
		return "", time.Time{}, false
	}
	return state, time.Unix(0, n), true
}
