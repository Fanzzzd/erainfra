// Package convexnode implements the opt-in Convex Node transport, separate from the Hub protocol.
package convexnode

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
)

const maxJournalBytes = 16 * 1024 * 1024

// maxJournalKeys bounds the keys the journal holds at once. Compaction keeps a healthy Node far
// below it: only commands Convex can still re-deliver, and outcomes an operator has to check,
// stay. Reaching it takes that many unchecked outcomes (see ErrJournalFull).
var maxJournalKeys = 10000

// maxJournalGarbage is how many superseded and settled lines the file may carry before it is
// rewritten with only the live records. With at most maxJournalKeys live records of at most
// 1 KiB each, the file stays under maxJournalKeys+maxJournalGarbage KiB, inside maxJournalBytes.
var maxJournalGarbage = 1024

const journalFile = "execution.jsonl"

// journalLock is held for the client's lifetime. The journal file itself is replaced on every
// rewrite, so a lock on its inode alone would not keep a second process out across a rewrite.
const journalLock = "execution.lock"

const (
	outcomeAccepted = "accepted"
	outcomeSuccess  = "success"
	outcomeFailure  = "failure"
	outcomeUnknown  = "unknown"
	// outcomeSettled removes a key. It is written once Convex has acknowledged the key's outcome
	// on a terminal command, or when an operator releases the key after checking it.
	outcomeSettled = "settled"
)

const bindingKey = "binding"

type record struct {
	Key     string `json:"key"`
	ID      string `json:"id"`
	Outcome string `json:"outcome"` // accepted is deliberately indeterminate after process interruption.
}

// ErrJournalFull is returned for a new journaled command when the journal holds maxJournalKeys
// keys after compaction. Every key left is either a command Convex can still deliver or an
// outcome nobody has confirmed, so the Node refuses new work rather than forget one of them.
var ErrJournalFull = errors.New("journal key limit reached")

type journalFullError struct{ keys, unknown int }

func (e journalFullError) Error() string {
	return fmt.Sprintf("%v: %d keys are held, %d of them unknown outcomes; new builds, deploys and operations are refused until an operator checks them (stop the Infra Agent, run `infra-agent journal list`, then `infra-agent journal release`; see docs/infra-management.md, \"When the journal is full\")", ErrJournalFull, e.keys, e.unknown)
}
func (e journalFullError) Is(target error) bool { return target == ErrJournalFull }

// journalError marks a failure to read or write the journal itself, so the heartbeat can tell
// it from a refused request.
type journalError struct{ err error }

func (e journalError) Error() string { return "journal: " + e.err.Error() }
func (e journalError) Unwrap() error { return e.err }

// Journal is append-only between rewrites and locked for the entire client lifetime. Acceptance
// is fsynced before execution; results are fsynced before reporting. An accepted entry found at
// startup becomes unknown, not a reason to repeat a restart/deploy. No payload, output or secret
// is ever stored.
//
// A key exists so that a re-delivered command replays its recorded outcome instead of repeating
// its effect. Convex never re-delivers a terminal command (nodeCommands.claim refuses one, and no
// path moves a terminal row back to pending or deletes it), so a key is settled, and forgotten,
// exactly when Convex has accepted its success or failure: either the report returned 200, or a
// status sweep finds the command terminal with that same outcome. An unknown outcome is never
// settled automatically, nor is a key whose command ended without Convex accepting its outcome
// (cancelled while it ran, for one); those wait for an operator.
type Journal struct {
	dir     string
	lock    *os.File
	file    *os.File
	records map[string]record
	// review holds keys a sweep found terminal in Convex without the outcome recorded here. They
	// are never re-delivered and never settled automatically, so later sweeps skip them.
	review map[string]bool
	bytes  int64
	lines  int
}

// JournalEntry is one key as `infra-agent journal list` prints it.
type JournalEntry struct {
	Key       string `json:"key"`
	CommandID string `json:"commandId"`
	Outcome   string `json:"outcome"`
}

func privateStateDir(dir string, create bool) error {
	if create {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return errors.New("state directory must be private (0700), not a symlink")
	}
	return nil
}

func privateFile(path string) error {
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		return errors.New("journal must be a private regular file")
	}
	return nil
}

func OpenJournal(dir string) (*Journal, error) {
	if err := privateStateDir(dir, true); err != nil {
		return nil, err
	}
	lockPath := filepath.Join(dir, journalLock)
	if err := privateFile(lockPath); err != nil {
		return nil, err
	}
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err := lockJournal(lock); err != nil {
		_ = lock.Close()
		return nil, errors.New("another process owns this Node journal")
	}
	j := &Journal{dir: dir, lock: lock, review: make(map[string]bool)}
	fail := func(err error) (*Journal, error) { _ = j.Close(); return nil, err }
	// A rewrite interrupted before its rename leaves only this; the journal itself is intact.
	if err := os.Remove(filepath.Join(dir, journalFile+".tmp")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fail(err)
	}
	if err := j.openFile(); err != nil {
		return fail(err)
	}
	stat, err := j.file.Stat()
	if err != nil {
		return fail(err)
	}
	if stat.Size() > maxJournalBytes {
		return fail(errors.New("journal size limit reached"))
	}
	records, lines, err := parseJournal(j.file, false)
	if err != nil {
		return fail(err)
	}
	j.records, j.lines, j.bytes = records, lines, stat.Size()
	if len(j.records) > maxJournalKeys {
		return fail(journalFullError{keys: len(j.records), unknown: j.unknownCount()})
	}
	// Persist the directory entry before the first effect, including a newly created journal.
	if err := syncJournalDirectory(dir); err != nil {
		return fail(err)
	}
	if j.lines-len(j.records) > 0 {
		// Start from a file holding only live records.
		if err := j.rewrite(); err != nil {
			return fail(err)
		}
	}
	return j, nil
}

// openFile opens and locks the journal file. The lock on the file, beside the one on
// execution.lock, keeps out an older Infra Agent, which locks only the journal.
func (j *Journal) openFile() error {
	path := filepath.Join(j.dir, journalFile)
	if err := privateFile(path); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return err
	}
	if err := lockJournal(f); err != nil {
		_ = f.Close()
		return errors.New("another process owns this Node journal")
	}
	j.file = f
	return nil
}

// parseJournal reads every record. With tolerateTail, an incomplete last line (a write in
// progress, seen by a reader that does not hold the lock) is ignored instead of refused.
func parseJournal(f io.Reader, tolerateTail bool) (map[string]record, int, error) {
	records := make(map[string]record)
	lines := 0
	reader := bufio.NewReader(io.LimitReader(f, maxJournalBytes+1))
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF && len(line) == 0 {
			break
		}
		if err != nil {
			if tolerateTail && err == io.EOF {
				break
			}
			return nil, 0, errors.New("incomplete journal record: outcome is unknown; manual recovery required")
		}
		lines++
		var r record
		if len(line) > 1024 || json.Unmarshal(line, &r) != nil || r.Key == "" || r.ID == "" {
			return nil, 0, errors.New("invalid journal record")
		}
		if r.Outcome == outcomeAccepted {
			r.Outcome = outcomeUnknown
		}
		old, exists := records[r.Key]
		if exists && old.ID != r.ID {
			return nil, 0, errors.New("journal idempotency collision")
		}
		switch r.Outcome {
		case outcomeSuccess, outcomeFailure, outcomeUnknown:
			records[r.Key] = r
		case outcomeSettled:
			delete(records, r.Key)
		default:
			return nil, 0, errors.New("invalid journal outcome")
		}
	}
	return records, lines, nil
}

// Close leaves a file of live records only, so an older Infra Agent, which does not know the
// settled record, can still open the journal after a clean stop.
func (j *Journal) Close() error {
	var err error
	if j.file != nil && j.lines > len(j.records) {
		err = j.rewrite()
	}
	if j.file != nil {
		if closeErr := j.file.Close(); err == nil {
			err = closeErr
		}
		j.file = nil
	}
	if j.lock != nil {
		if lockErr := j.lock.Close(); err == nil {
			err = lockErr
		}
		j.lock = nil
	}
	return err
}

func (j *Journal) lookup(key, id string) (string, bool, error) {
	r, ok := j.records[key]
	if ok && r.ID != id {
		return "", false, errors.New("idempotency key has a different command id")
	}
	return r.Outcome, ok, nil
}

// full reports whether a new key would be refused.
func (j *Journal) full() bool { return len(j.records) >= maxJournalKeys }

// keys is the number of command keys held, not counting this Node's binding.
func (j *Journal) keys() int {
	if _, ok := j.records[bindingKey]; ok {
		return len(j.records) - 1
	}
	return len(j.records)
}

func (j *Journal) unknownCount() int {
	n := 0
	for _, r := range j.records {
		if r.Outcome == outcomeUnknown || r.Outcome == outcomeAccepted {
			n++
		}
	}
	return n
}

func (j *Journal) fullError() error {
	return journalFullError{keys: j.keys(), unknown: j.unknownCount()}
}

func (j *Journal) append(key, id, outcome string) error {
	if _, exists := j.records[key]; !exists {
		if outcome == outcomeSettled {
			return errors.New("no such journal key")
		}
		if j.full() {
			return j.fullError()
		}
	}
	if j.file == nil {
		return journalError{errors.New("journal is closed")}
	}
	r := record{Key: key, ID: id, Outcome: outcome}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if len(b) > 1024 || j.bytes+int64(len(b)) > maxJournalBytes {
		return journalError{errors.New("journal size limit reached")}
	}
	n, err := j.file.Write(b)
	if err != nil {
		return journalError{err}
	}
	if n != len(b) {
		return journalError{fmt.Errorf("journal short write")}
	}
	if err = j.file.Sync(); err != nil {
		return journalError{err}
	}
	j.bytes += int64(n)
	j.lines++
	if outcome == outcomeSettled {
		delete(j.records, key)
		delete(j.review, key)
	} else {
		j.records[key] = r
	}
	if j.lines-len(j.records) >= maxJournalGarbage {
		return j.rewrite()
	}
	return nil
}

// settle forgets a key whose outcome Convex has accepted on a terminal command. Only a success
// or failure is settled: an unknown outcome stays for an operator, whatever Convex recorded.
// It reports whether the key was settled.
func (j *Journal) settle(key, id string) (bool, error) {
	r, ok := j.records[key]
	if !ok || r.ID != id || key == bindingKey || (r.Outcome != outcomeSuccess && r.Outcome != outcomeFailure) {
		return false, nil
	}
	if err := j.append(key, id, outcomeSettled); err != nil {
		return false, err
	}
	return true, nil
}

// settleMany forgets several acknowledged keys with one rewrite, so a sweep over thousands of
// keys costs one fsync, not one per key. A crash before the rewrite only brings them back for
// the next sweep.
func (j *Journal) settleMany(keys []string) error {
	removed := 0
	for _, key := range keys {
		r, ok := j.records[key]
		if !ok || key == bindingKey || (r.Outcome != outcomeSuccess && r.Outcome != outcomeFailure) {
			continue
		}
		delete(j.records, key)
		delete(j.review, key)
		removed++
	}
	if removed == 0 {
		return nil
	}
	return j.rewrite()
}

// sweepCandidates are the keys a status sweep can settle: a success or failure not yet found
// to be terminal under another outcome. Unknown outcomes are never candidates.
func (j *Journal) sweepCandidates() []record {
	var out []record
	for key, r := range j.records {
		if key == bindingKey || j.review[key] || (r.Outcome != outcomeSuccess && r.Outcome != outcomeFailure) {
			continue
		}
		out = append(out, r)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Key < out[b].Key })
	return out
}

// rewrite replaces the file with one holding only the live records: written beside it, fsynced,
// renamed over it, then the directory fsynced. A crash at any point leaves either the old file or
// the new one, each complete. execution.lock stays held throughout.
func (j *Journal) rewrite() error {
	keys := make([]string, 0, len(j.records))
	for key := range j.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	tmpPath := filepath.Join(j.dir, journalFile+".tmp")
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return journalError{err}
	}
	w := bufio.NewWriter(tmp)
	var size int64
	for _, key := range keys {
		b, err := json.Marshal(j.records[key])
		if err == nil {
			b = append(b, '\n')
			size += int64(len(b))
			_, err = w.Write(b)
		}
		if err != nil {
			_ = tmp.Close()
			_ = os.Remove(tmpPath)
			return journalError{err}
		}
	}
	if err = w.Flush(); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(tmpPath)
		return journalError{err}
	}
	// Windows cannot rename over an open file, so the old handle is closed first; on any failure
	// the journal is reopened from whichever file the rename left in place.
	_ = j.file.Close()
	j.file = nil
	renameErr := os.Rename(tmpPath, filepath.Join(j.dir, journalFile))
	if renameErr == nil {
		renameErr = syncJournalDirectory(j.dir)
	}
	if err := j.openFile(); err != nil {
		return journalError{err}
	}
	if renameErr != nil {
		_ = os.Remove(tmpPath)
		return journalError{renameErr}
	}
	j.bytes, j.lines = size, len(keys)
	return nil
}

// ListJournal reads the journal in dir without taking its lock, so an operator can look while
// the Infra Agent runs. It lists every command key, sorted, with an unfinished one as unknown.
func ListJournal(dir string) ([]JournalEntry, error) {
	if err := privateStateDir(dir, false); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, journalFile)
	if err := privateFile(path); err != nil {
		return nil, err
	}
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return []JournalEntry{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	records, _, err := parseJournal(f, true)
	if err != nil {
		return nil, err
	}
	out := make([]JournalEntry, 0, len(records))
	for key, r := range records {
		if key == bindingKey {
			continue
		}
		out = append(out, JournalEntry{Key: key, CommandID: r.ID, Outcome: r.Outcome})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Key < out[b].Key })
	return out, nil
}

// ReleaseJournalKeys forgets keys an operator has checked by hand. It takes the journal's lock,
// so the Infra Agent must be stopped. After this, a re-delivery of one of these commands would
// run it again; release a key only once Convex shows its command finished or cancelled.
func ReleaseJournalKeys(dir string, keys []string) error {
	if err := privateStateDir(dir, false); err != nil {
		return err
	}
	j, err := OpenJournal(dir)
	if err != nil {
		return err
	}
	defer func() { _ = j.Close() }()
	if len(keys) == 0 {
		return errors.New("name at least one key to release")
	}
	for _, key := range keys {
		if key == bindingKey {
			return errors.New("the binding record ties the journal to its Node and is never released")
		}
		if _, ok := j.records[key]; !ok {
			return fmt.Errorf("no journal key %q", key)
		}
	}
	for _, key := range keys {
		delete(j.records, key)
	}
	return j.rewrite()
}
