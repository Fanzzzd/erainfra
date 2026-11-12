// Package convexnode implements the Infra Agent's Convex Node transport (connect-convex).
package convexnode

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"

	"github.com/Fanzzzd/erainfra/apps/infra-agent/internal/oplog"
)

const maxJournalBytes = 16 * 1024 * 1024

// maxJournalKeys bounds the keys the journal holds at once. Compaction keeps a Node far below it:
// only commands Convex can still re-deliver, and commands Convex does not know, stay. Reaching it
// takes that many commands Convex has not confirmed finished (see ErrJournalFull).
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
	// outcomeSettled removes a key. It is written once Convex holds the key's command terminal,
	// so it can never be delivered again, or when an operator releases the key after checking it.
	outcomeSettled = "settled"
)

const bindingKey = "binding"

type record struct {
	Key     string `json:"key"`
	ID      string `json:"id"`
	Outcome string `json:"outcome"` // accepted is deliberately indeterminate after process interruption.
}

// ErrJournalFull is returned for a new journaled command when the journal holds maxJournalKeys
// keys after compaction. Every key left is a command Convex can still deliver, does not know, or
// has not answered for, so the Node refuses new work rather than forget one of them.
var ErrJournalFull = errors.New("journal key limit reached")

type journalFullError struct{ keys, unknown int }

func (e journalFullError) Error() string {
	return fmt.Sprintf("%v: %d keys are held, %d of them unknown outcomes, and Convex has not finished their commands; new builds, deploys and operations are refused until it does or an operator checks them (stop the Infra Agent, run `infra-agent journal list`, then `infra-agent journal release`; see docs/infra-management.md, \"When the journal is full\")", ErrJournalFull, e.keys, e.unknown)
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
// its effect, and for nothing else. Convex never re-delivers a terminal command
// (nodeCommands.claim refuses one, no path moves a terminal row back to pending or deletes it,
// and an idempotency key names one row per Node forever), so a key is settled, and forgotten,
// exactly when Convex holds its command terminal: the report returned 200, or a status sweep
// finds the command success, failure, unknown or cancelled. That includes an unknown outcome and
// a command cancelled while it ran. Convex shows those to the operator where they act on them
// (the command row, and the deploy run that failed with "inspect the Node"), and a key kept here
// would only fill the journal until the Node refused all new work; the sweep logs any outcome
// that differs from what Convex recorded before it forgets the key.
type Journal struct {
	dir     string
	lock    *os.File
	file    *os.File
	records map[string]record
	// review holds keys a sweep found missing from Convex. Nothing confirms they cannot be
	// delivered again, so they are kept for an operator, and later sweeps skip them.
	review map[string]bool
	bytes  int64
	lines  int
	// broken is set when a failed write left the file in a state this process cannot vouch for.
	// Appends are refused until the agent restarts and Open reads back what the disk holds.
	broken error
}

// journalLogf receives the journal's warnings: a torn record recovered at open. The Infra Agent
// logs to stderr, which systemd keeps.
var journalLogf = oplog.Printf

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
	scan, err := scanJournal(j.file)
	if err != nil {
		return fail(err)
	}
	j.records, j.lines, j.bytes = scan.records, scan.lines, stat.Size()
	if len(j.records) > maxJournalKeys {
		return fail(journalFullError{keys: len(j.records), unknown: j.unknownCount()})
	}
	// Persist the directory entry before the first effect, including a newly created journal.
	if err := syncJournalDirectory(dir); err != nil {
		return fail(err)
	}
	if scan.recovered != "" {
		journalLogf("connect-convex: WARNING: journal %s: %s", filepath.Join(dir, journalFile), scan.recovered)
	}
	if scan.recovered != "" || j.lines-len(j.records) > 0 {
		// Start from a file holding only live records. After a recovery this is also what takes
		// the torn record off the disk, atomically, before anything is appended after it.
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

// journalScan is what scanJournal read: the live records, how many complete lines held them, and,
// when the last record was torn, what was done about it.
type journalScan struct {
	records   map[string]record
	lines     int
	recovered string
}

// recordStart reads the key and command id from a damaged record. json.Marshal writes a record's
// fields in declaration order, so an intact start of the line holds both.
var recordStart = regexp.MustCompile(`"key":("(?:[^"\\\x00-\x1f]|\\.)*"),"id":("(?:[^"\\\x00-\x1f]|\\.)*")`)

// scanJournal reads every record. A damaged record anywhere but the end is refused: that is not
// an interrupted append but a damaged file, and nothing says what the record held.
//
// A damaged last record is what power loss during an append leaves, and it is recovered here, the
// way a write-ahead log drops a torn final record (etcd's WAL repair). Whether dropping it is safe
// depends on what the record was. The agent acts on a record only once its write and fsync have
// returned, and every record after a key's first one only moves the key towards a state Convex
// holds (an outcome after `accepted`, `settled` after a reported outcome):
//
//   - The line has no newline. Its write never completed, so its fsync never returned and the
//     agent never acted on it; it is dropped whatever it was. A dropped `accepted` is a command
//     that never started, so running it if Convex delivers it again is correct. A dropped outcome
//     leaves the key's `accepted`, which reads back as unknown: the command is reported unknown
//     and never runs again. A dropped `settled` brings its key back until the next report or
//     sweep settles it again. A dropped binding record is written again by the next heartbeat.
//   - The line ends in a newline but does not parse. The file's size reached the disk ahead of
//     some of its data, or the record was damaged after it was written, so the agent may have
//     acted on it. If its key and command id can still be read, a key the journal already holds
//     keeps its earlier state (the lost record could only have moved it towards what Convex
//     holds), and a key it did not hold, which could be an `accepted` whose effect started, is
//     kept as unknown, so its command never runs again. A record whose key cannot be read is
//     refused: nothing says which command must not run again.
//
// ListJournal reads without the lock while the agent may be appending, so there an unterminated
// last line is usually a write in progress; it is skipped the same way.
func scanJournal(f io.Reader) (journalScan, error) {
	data, err := io.ReadAll(io.LimitReader(f, maxJournalBytes+1))
	if err != nil {
		return journalScan{}, err
	}
	if len(data) > maxJournalBytes {
		return journalScan{}, errors.New("journal size limit reached")
	}
	scan := journalScan{records: make(map[string]record)}
	for offset := 0; offset < len(data); {
		end := bytes.IndexByte(data[offset:], '\n')
		if end < 0 {
			scan.recovered = fmt.Sprintf("dropped the torn record at line %d, which an interrupted append left without its newline: %s. Its write never finished, so the agent never acted on it and the key keeps its earlier state", scan.lines+1, quoteRecord(data[offset:]))
			break
		}
		line := data[offset : offset+end+1]
		offset += len(line)
		r, err := parseRecord(line)
		if err == nil {
			if err = scan.apply(r); err != nil {
				return journalScan{}, err
			}
			scan.lines++
			continue
		}
		if offset < len(data) {
			return journalScan{}, fmt.Errorf("journal record at line %d is damaged (%v) and is not the last one, so it is not an interrupted append; the Infra Agent will not guess what it held (see docs/infra-management.md, \"When the journal is damaged\")", scan.lines+1, err)
		}
		match := recordStart.FindSubmatch(line)
		var key, id string
		if match == nil || json.Unmarshal(match[1], &key) != nil || json.Unmarshal(match[2], &id) != nil || key == "" || id == "" {
			return journalScan{}, fmt.Errorf("the last journal record, line %d, is damaged and its key cannot be read: %s. The command it belonged to may have started, so the Infra Agent will not guess (see docs/infra-management.md, \"When the journal is damaged\")", scan.lines+1, quoteRecord(line))
		}
		old, held := scan.records[key]
		switch {
		case held && old.ID != id:
			return journalScan{}, errors.New("journal idempotency collision")
		case held, key == bindingKey:
			scan.recovered = fmt.Sprintf("dropped the damaged last record at line %d, for key %q: %s. The key keeps its earlier state", scan.lines+1, key, quoteRecord(line))
		default:
			scan.records[key] = record{Key: key, ID: id, Outcome: outcomeUnknown}
			scan.recovered = fmt.Sprintf("the damaged last record at line %d is the first for key %q, command %s: %s. Its command may have started, so the key is kept as unknown and the command will not run again", scan.lines+1, key, id, quoteRecord(line))
		}
	}
	return scan, nil
}

func parseRecord(line []byte) (record, error) {
	var r record
	if len(line) > 1024 {
		return r, errors.New("record too long")
	}
	if json.Unmarshal(line, &r) != nil || r.Key == "" || r.ID == "" {
		return r, errors.New("invalid journal record")
	}
	switch r.Outcome {
	case outcomeAccepted, outcomeSuccess, outcomeFailure, outcomeUnknown, outcomeSettled:
		return r, nil
	default:
		return r, errors.New("invalid journal outcome")
	}
}

func (s *journalScan) apply(r record) error {
	if r.Outcome == outcomeAccepted {
		r.Outcome = outcomeUnknown
	}
	if old, exists := s.records[r.Key]; exists && old.ID != r.ID {
		return errors.New("journal idempotency collision")
	}
	if r.Outcome == outcomeSettled {
		delete(s.records, r.Key)
	} else {
		s.records[r.Key] = r
	}
	return nil
}

// quoteRecord shows damaged record bytes in a log line. Records hold only keys, command ids and
// outcomes, never payloads or secrets.
func quoteRecord(b []byte) string {
	if len(b) > 256 {
		return fmt.Sprintf("%q... (%d bytes)", b[:256], len(b))
	}
	return fmt.Sprintf("%q", b)
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
	if j.broken != nil {
		return journalError{fmt.Errorf("an earlier write could not be undone (%v); restart the Infra Agent so it reads back what the disk holds", j.broken)}
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
	if err == nil && n != len(b) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = j.file.Sync()
	}
	if err != nil {
		// A partial line left behind would sit in the middle of the file once the next record
		// lands after it, which Open refuses; and after a failed fsync the kernel may have dropped
		// the line's pages without saying so again. Either way the agent did not act on this
		// record, so the file is rewritten from memory, which holds exactly what it acted on. If
		// even that fails, nothing more is appended until a restart.
		if rewriteErr := j.rewrite(); rewriteErr != nil {
			j.broken = err
		}
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

// settle forgets a key once Convex has accepted its outcome, which makes the command terminal:
// success, failure and unknown alike. It reports whether the key was settled.
func (j *Journal) settle(key, id string) (bool, error) {
	r, ok := j.records[key]
	if !ok || r.ID != id || !settleable(key, r) {
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
		if !ok || !settleable(key, r) {
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

// settleable is whether a key may be forgotten once Convex holds its command terminal. The
// binding is never a command. An `accepted` record in memory is the command this process is
// running now (a restart reads it back as unknown), so it waits for its own outcome.
func settleable(key string, r record) bool {
	return key != bindingKey && r.Outcome != outcomeAccepted
}

// sweepCandidates are the keys a status sweep asks Convex about: every command key not already
// found missing from Convex.
func (j *Journal) sweepCandidates() []record {
	var out []record
	for key, r := range j.records {
		if !settleable(key, r) || j.review[key] {
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
	scan, err := scanJournal(f)
	if err != nil {
		return nil, err
	}
	out := make([]JournalEntry, 0, len(scan.records))
	for key, r := range scan.records {
		if key == bindingKey {
			continue
		}
		out = append(out, JournalEntry{Key: key, CommandID: r.ID, Outcome: r.Outcome})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Key < out[b].Key })
	return out, nil
}

// ReleaseJournalKeys forgets keys an operator has checked by hand. It takes the journal's lock,
// so the Infra Agent must be stopped. Like the agent, it recovers a torn last record first (see
// scanJournal), so power loss during an append never leaves the operator without this way out.
// After this, a re-delivery of one of these commands would run it again; release a key only once
// Convex shows its command finished or cancelled.
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
