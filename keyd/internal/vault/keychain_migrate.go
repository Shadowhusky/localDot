package vault

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// markerAccount names the Keychain item in which keyd records its one migration of the values a
// keyd from before bindings stored. It is not a secret id, so no user secret can take it.
const markerAccount = "_bindings"

const (
	markerPrefix  = "keyd-bindings:2:"
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
	// Rebound lists the records whose values were stored for another destination than the record
	// names: the record was changed outside keyd.
	Rebound []string
	// Done reports that the migration is recorded as finished; it never runs again.
	Done bool
}

type itemState int

const (
	itemReadable itemState = iota
	itemReenter
	itemRebound
	itemUnknown
)

// head is what a record's item head read as at the start of a pass.
type head struct {
	text string
	err  error
}

// MigrateBindings binds, once, each value an earlier keyd stored without its binding to the record
// the index held for it when the migration began, and names the records whose values cannot be
// used as they are stored.
//
// Every keyd binary from before bindings reads an unbound item for whatever index it is given, so
// binding the items keyd wrote closes that, and binds each one to where keyd was already sending
// it. A bound item is never touched. The migration begins on the first start that finds no marker
// and no bound item: the marker, a Keychain item only signed keyd can read, then records the id and
// binding of every record the index held, and only an item laid out exactly as keyd lays one out,
// under a record whose id and binding are in that record, is bound. An index changed afterwards
// binds nothing new, and neither does another keyd home with its own index, since the record lives
// in the shared Keychain. Every other unbound item stays refused until its value is stored again.
// The marker is marked done after the last item settles, so a migration cut short resumes with the
// same record, and a finished one never runs again. Binding rewrites the item head alone, in one
// write, leaving the chunks as they are: a crash leaves the item unbound, for the next start to
// bind, or bound.
func (k *Keychain) MigrateBindings(records []Record) Migration {
	heads, bound := k.readHeads(records)
	snapshot, state := k.beginMigration(records, bound)
	m := Migration{Done: state == markerDone}
	complete := true
	for _, rec := range records {
		h, ok := heads[rec.ID]
		if !ok {
			continue
		}
		switch item, bound := k.settle(rec, h, snapshot, state); {
		case item == itemReenter:
			m.Reenter = append(m.Reenter, rec.ID)
		case item == itemRebound:
			m.Rebound = append(m.Rebound, rec.ID)
		case item == itemUnknown:
			complete = false
		case bound:
			m.Bound = append(m.Bound, rec.ID)
		}
	}
	if state == markerRunning && complete {
		m.Done = k.endMigration()
	}
	return m
}

// readHeads reads each record's item head, and whether any of them is bound.
func (k *Keychain) readHeads(records []Record) (map[string]head, bool) {
	heads := map[string]head{}
	bound := false
	for _, rec := range records {
		if !Writable(rec.ID) {
			continue
		}
		ctx, cancel := k.deadline()
		text, err := k.find(ctx, rec.ID)
		cancel()
		heads[rec.ID] = head{text, err}
		if _, _, binding, ok := parseHead(text); err == nil && ok && binding != "" {
			bound = true
		}
	}
	return heads, bound
}

// beginMigration reads the marker and returns the records the migration may bind, while it runs,
// and its state; no state while the Keychain cannot say. A start that finds no marker writes one:
// running, with the index's records, or done when an item is already bound, since then the
// migration ran before and its marker was removed.
func (k *Keychain) beginMigration(records []Record, bound bool) ([]string, string) {
	ctx, cancel := k.deadline()
	defer cancel()
	data, err := k.find(ctx, markerAccount)
	if errors.Is(err, ErrNotFound) {
		snapshot, state := snapshotOf(records), markerRunning
		if bound || len(markerText(state, snapshot)) > helperItemLimit {
			log.Printf("keyd: the binding migration closes without binding: an item is already bound, or the index is too large")
			snapshot, state = nil, markerDone
		}
		if err := k.add(ctx, markerAccount, markerText(state, snapshot)); err != nil {
			log.Printf("keyd: the binding migration could not begin: %v", err)
			return nil, ""
		}
		return snapshot, state
	}
	if errors.Is(err, ErrReenter) {
		log.Printf("keyd: the binding migration marker is not keyd's")
		return nil, markerForeign
	}
	if err != nil {
		log.Printf("keyd: the binding migration marker could not be read: %v", err)
		return nil, ""
	}
	state, snapshot, ok := parseMarker(data)
	if !ok {
		log.Printf("keyd: the binding migration marker is not keyd's")
		return nil, markerForeign
	}
	return snapshot, state
}

func (k *Keychain) endMigration() bool {
	ctx, cancel := k.deadline()
	defer cancel()
	if err := k.add(ctx, markerAccount, markerText(markerDone, nil)); err != nil {
		log.Printf("keyd: the binding migration could not be recorded as done: %v", err)
		return false
	}
	return true
}

// settle classifies rec's stored value and, while the migration runs, binds it if keyd can prove it
// wrote it for this record. An error that may pass, such as a locked Keychain or a helper that timed
// out, leaves the state unknown.
func (k *Keychain) settle(rec Record, h head, snapshot []string, migration string) (itemState, bool) {
	switch {
	case errors.Is(h.err, ErrNotFound), errors.Is(h.err, ErrReenter):
		return itemReenter, false
	case h.err != nil:
		return itemUnknown, false
	}
	binding := bindingOf(rec)
	_, _, bound, ok := parseHead(h.text)
	switch {
	case ok && bound == binding:
		return itemReadable, false
	case ok && bound != "":
		return itemRebound, false
	case ok && migration == "":
		return itemUnknown, false
	case !ok || migration != markerRunning || !slices.Contains(snapshot, recordDigest(rec.ID, binding)):
		return itemReenter, false
	}
	match := legacyHeadPattern.FindStringSubmatch(h.text)
	if match == nil {
		return itemReenter, false
	}
	gen := match[1]
	count, err := strconv.Atoi(match[2])
	if err != nil || count > maxChunks {
		return itemReenter, false
	}
	ctx, cancel := k.deadline()
	defer cancel()
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
		case errors.Is(err, ErrNotFound), errors.Is(err, ErrReenter):
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

// recordDigest names a record's id and binding in the marker: the first 16 bytes of their SHA-256.
func recordDigest(id, binding string) string {
	sum := sha256.Sum256([]byte(id + "\x00" + binding))
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

func snapshotOf(records []Record) []string {
	snapshot := []string{}
	for _, rec := range records {
		if Writable(rec.ID) {
			snapshot = append(snapshot, recordDigest(rec.ID, bindingOf(rec)))
		}
	}
	slices.Sort(snapshot)
	return snapshot
}

func markerText(state string, snapshot []string) string {
	if state == markerDone {
		return markerPrefix + markerDone
	}
	return markerPrefix + markerRunning + ":" + strings.Join(snapshot, ",")
}

var digestPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func parseMarker(data string) (string, []string, bool) {
	rest, ok := strings.CutPrefix(data, markerPrefix)
	if !ok {
		return "", nil, false
	}
	if rest == markerDone {
		return markerDone, nil, true
	}
	list, ok := strings.CutPrefix(rest, markerRunning+":")
	if !ok {
		return "", nil, false
	}
	if list == "" {
		return markerRunning, []string{}, true
	}
	snapshot := strings.Split(list, ",")
	for _, digest := range snapshot {
		if !digestPattern.MatchString(digest) {
			return "", nil, false
		}
	}
	return markerRunning, snapshot, true
}
