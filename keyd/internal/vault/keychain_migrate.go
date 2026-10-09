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
	markerPrefix  = "keyd-bindings:3:"
	markerRunning = "running"
	markerDone    = "done"
	// markerForeign is a marker keyd did not write; it keeps the migration closed for good.
	markerForeign = "foreign"
)

// retiredHead replaces the head of a value stored before bindings that the migration did not bind,
// once it ends: no later migration binds it, whatever the index then says.
const retiredHead = "keyd:unbound"

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

// marker is the migration as its Keychain item records it: its state and, for each record the index
// held when it began, the binding that record asked for, by digests of its id and of id and binding.
// No state means the Keychain could not say.
type marker struct {
	state string
	asked map[string]string
}

// MigrateBindings binds, once, each value an earlier keyd stored without its binding to the record
// the index held for it when the migration began, and names the records whose values cannot be
// used as they are stored.
//
// Every keyd binary from before bindings reads an unbound item for whatever index it is given, so
// binding the items keyd wrote closes that, and binds each one to where keyd was already sending
// it. A bound item is never touched. The migration begins on the first start that finds no marker
// and reads every head of the service, none bound or retired: the marker, a Keychain item only
// signed keyd can read, then records the binding each record of the index asked for, and only an
// item laid out exactly as keyd lays one out, under a record whose id and binding are in that
// record, is bound. A record whose id is there with another binding was changed outside keyd and is
// listed as rebound, before and after the migration ends. An index changed afterwards binds nothing
// new, and neither does another keyd home with its own index, since the record lives in the shared
// Keychain. Every other unbound item stays refused until its value is stored again. Before any
// marker records the migration as done, whether its last record settled or it closed without
// binding, every unbound head of the service is retired. A migration cut short resumes with the
// same record, and a finished one never runs again, even with its marker removed. Binding rewrites
// the item head alone, in one write, leaving the chunks as they are: a crash leaves the item
// unbound, for the next start to bind, or bound.
func (k *Keychain) MigrateBindings(records []Record) Migration {
	heads := k.readHeads(records)
	mark := k.beginMigration(records)
	m := Migration{Done: mark.state == markerDone}
	complete := true
	for _, rec := range records {
		h, ok := heads[rec.ID]
		if !ok {
			continue
		}
		switch item, bound := k.settle(rec, h, mark); {
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
	if mark.state == markerRunning && complete {
		m.Done = k.endMigration(mark)
	}
	return m
}

// readHeads reads each record's item head.
func (k *Keychain) readHeads(records []Record) map[string]head {
	heads := map[string]head{}
	for _, rec := range records {
		if !Writable(rec.ID) {
			continue
		}
		ctx, cancel := k.deadline()
		text, err := k.find(ctx, rec.ID)
		cancel()
		heads[rec.ID] = head{text, err}
	}
	return heads
}

// beginMigration reads the marker. A start that finds none writes one: running, with what the
// index's records ask for, or done when an item of the service is already bound or retired, since
// then the migration ran before and its marker was removed, or when the index is too large to
// record. A migration that closes so binds nothing and retires every unbound head first.
func (k *Keychain) beginMigration(records []Record) marker {
	ctx, cancel := k.deadline()
	data, err := k.find(ctx, markerAccount)
	cancel()
	switch {
	case errors.Is(err, ErrNotFound):
		return k.markMigration(records)
	case errors.Is(err, ErrReenter):
		log.Printf("keyd: the binding migration marker is not keyd's")
		return marker{state: markerForeign}
	case err != nil:
		log.Printf("keyd: the binding migration marker could not be read: %v", err)
		return marker{}
	}
	mark, ok := parseMarker(data)
	if !ok {
		log.Printf("keyd: the binding migration marker is not keyd's")
		return marker{state: markerForeign}
	}
	return mark
}

func (k *Keychain) markMigration(records []Record) marker {
	heads, err := k.serviceHeads()
	if err != nil {
		log.Printf("keyd: the binding migration could not begin: %v", err)
		return marker{}
	}
	mark := marker{state: markerRunning, asked: askedBy(records)}
	if migratedBefore(heads) || len(mark.text()) > helperItemLimit {
		log.Printf("keyd: the binding migration closes without binding: an item is already bound, or the index is too large")
		if !k.retire(heads) {
			return marker{}
		}
		mark = marker{state: markerDone}
	}
	ctx, cancel := k.deadline()
	defer cancel()
	if err := k.add(ctx, markerAccount, mark.text()); err != nil {
		log.Printf("keyd: the binding migration could not begin: %v", err)
		return marker{}
	}
	return mark
}

// migratedBefore reports whether any head is bound or retired: only keyd after a migration began
// leaves one.
func migratedBefore(heads map[string]string) bool {
	for _, text := range heads {
		if _, _, binding, ok := parseHead(text); (ok && binding != "") || text == retiredHead {
			return true
		}
	}
	return false
}

// serviceHeads reads the head of every item of the service that holds one, whatever the index
// names. Only an item gone since the listing, or one that is not keyd's, is left out: any other
// head that does not read may be bound, retired or unbound, so it fails the whole read.
func (k *Keychain) serviceHeads() (map[string]string, error) {
	ids, err := k.secretItems()
	if err != nil {
		return nil, err
	}
	heads := map[string]string{}
	for _, id := range ids {
		ctx, cancel := k.deadline()
		text, err := k.find(ctx, id)
		cancel()
		switch {
		case errors.Is(err, ErrNotFound), errors.Is(err, ErrReenter):
			continue
		case err != nil:
			return nil, err
		}
		heads[id] = text
	}
	return heads, nil
}

// retire rewrites each unbound head in heads as retired and reads it back, so that no later
// migration binds it, whatever the index then says.
func (k *Keychain) retire(heads map[string]string) bool {
	for id, text := range heads {
		if !legacyHeadPattern.MatchString(text) {
			continue
		}
		ctx, cancel := k.deadline()
		err := k.add(ctx, id, retiredHead)
		if err == nil {
			if got, ferr := k.find(ctx, id); ferr != nil || got != retiredHead {
				err = errors.New("the retired head did not read back")
			}
		}
		cancel()
		if err != nil {
			log.Printf("keyd: the binding migration could not retire secret %s: %v", id, err)
			return false
		}
	}
	return true
}

// endMigration retires every unbound head the service still holds, under any id, then records the
// migration as done, keeping what each record asked for.
func (k *Keychain) endMigration(mark marker) bool {
	heads, err := k.serviceHeads()
	if err != nil {
		log.Printf("keyd: the binding migration could not finish: %v", err)
		return false
	}
	if !k.retire(heads) {
		return false
	}
	ctx, cancel := k.deadline()
	defer cancel()
	if err := k.add(ctx, markerAccount, marker{state: markerDone, asked: mark.asked}.text()); err != nil {
		log.Printf("keyd: the binding migration could not be recorded as done: %v", err)
		return false
	}
	return true
}

// settle classifies rec's stored value and, while the migration runs, binds it if keyd can prove it
// wrote it for this record. An error that may pass, such as a locked Keychain or a helper that timed
// out, leaves the state unknown.
func (k *Keychain) settle(rec Record, h head, mark marker) (itemState, bool) {
	switch {
	case errors.Is(h.err, ErrNotFound), errors.Is(h.err, ErrReenter):
		return itemReenter, false
	case h.err != nil:
		return itemUnknown, false
	}
	binding := bindingOf(rec)
	_, _, bound, ok := parseHead(h.text)
	unbound := (ok && bound == "") || h.text == retiredHead
	asked, known := mark.asked[digest(rec.ID)]
	switch {
	case ok && bound == binding:
		return itemReadable, false
	case ok && bound != "":
		return itemRebound, false
	case unbound && mark.state == "":
		return itemUnknown, false
	case unbound && known && asked != digest(rec.ID, binding):
		return itemRebound, false
	case !unbound || h.text == retiredHead || mark.state != markerRunning || !known:
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

// digest names what the marker records without naming it: the first 16 bytes of the SHA-256 of
// its parts. An id has no NUL, so an id's digest is never that of an id and binding.
func digest(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

// askedBy is what the records ask for, as the marker records it.
func askedBy(records []Record) map[string]string {
	asked := map[string]string{}
	for _, rec := range records {
		if Writable(rec.ID) {
			asked[digest(rec.ID)] = digest(rec.ID, bindingOf(rec))
		}
	}
	return asked
}

func (m marker) text() string {
	entries := make([]string, 0, len(m.asked))
	for id, binding := range m.asked {
		entries = append(entries, id+"."+binding)
	}
	slices.Sort(entries)
	return markerPrefix + m.state + ":" + strings.Join(entries, ",")
}

var digestPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func parseMarker(data string) (marker, bool) {
	rest, ok := strings.CutPrefix(data, markerPrefix)
	state, list, cut := strings.Cut(rest, ":")
	if !ok || !cut || (state != markerRunning && state != markerDone) {
		return marker{}, false
	}
	mark := marker{state: state, asked: map[string]string{}}
	if list == "" {
		return mark, true
	}
	for entry := range strings.SplitSeq(list, ",") {
		id, binding, cut := strings.Cut(entry, ".")
		if _, repeated := mark.asked[id]; !cut || repeated || !digestPattern.MatchString(id) || !digestPattern.MatchString(binding) {
			return marker{}, false
		}
		mark.asked[id] = binding
	}
	return mark, true
}
