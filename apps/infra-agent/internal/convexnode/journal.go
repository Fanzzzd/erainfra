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
)

const maxJournalBytes = 16 * 1024 * 1024
const maxJournalKeys = 10000

type record struct {
	Key     string `json:"key"`
	ID      string `json:"id"`
	Outcome string `json:"outcome"` // accepted is deliberately indeterminate after process interruption.
}

// Journal is append-only and locked for the entire client lifetime. Acceptance is fsynced before
// execution; results are fsynced before reporting. An accepted entry found at startup becomes
// unknown, not a reason to repeat a restart/deploy. No payload, output or secret is ever stored.
// Keys are never automatically evicted: reaching the bound fails closed rather than forgetting
// that an old non-idempotent effect might have happened.
type Journal struct {
	file    *os.File
	records map[string]record
	bytes   int64
}

func OpenJournal(dir string) (*Journal, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("state directory must be private (0700), not a symlink")
	}
	path := filepath.Join(dir, "execution.jsonl")
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0) {
		return nil, errors.New("journal must be a private regular file")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_APPEND, 0600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Journal, error) { _ = f.Close(); return nil, err }
	if err := lockJournal(f); err != nil {
		return fail(errors.New("another process owns this Node journal"))
	}
	stat, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	if stat.Size() > maxJournalBytes {
		return fail(errors.New("journal size limit reached"))
	}
	j := &Journal{file: f, records: make(map[string]record), bytes: stat.Size()}
	reader := bufio.NewReader(io.LimitReader(f, maxJournalBytes+1))
	for {
		line, err := reader.ReadBytes('\n')
		if err == io.EOF && len(line) == 0 {
			break
		}
		if err != nil {
			return fail(errors.New("incomplete journal record: outcome is unknown; manual recovery required"))
		}
		var r record
		if len(line) > 1024 || json.Unmarshal(line, &r) != nil || r.Key == "" || r.ID == "" {
			return fail(errors.New("invalid journal record"))
		}
		if r.Outcome == "accepted" {
			r.Outcome = "unknown"
		}
		if r.Outcome != "success" && r.Outcome != "failure" && r.Outcome != "unknown" {
			return fail(errors.New("invalid journal outcome"))
		}
		if old, exists := j.records[r.Key]; exists && old.ID != r.ID {
			return fail(errors.New("journal idempotency collision"))
		}
		j.records[r.Key] = r
	}
	if len(j.records) > maxJournalKeys {
		return fail(errors.New("journal key limit reached"))
	}
	// Persist the directory entry before the first effect, including a newly created journal.
	if err := syncJournalDirectory(dir); err != nil {
		return fail(err)
	}
	return j, nil
}
func (j *Journal) Close() error { return j.file.Close() }
func (j *Journal) lookup(key, id string) (string, bool, error) {
	r, ok := j.records[key]
	if ok && r.ID != id {
		return "", false, errors.New("idempotency key has a different command id")
	}
	return r.Outcome, ok, nil
}
func (j *Journal) append(key, id, outcome string) error {
	if _, exists := j.records[key]; !exists && len(j.records) >= maxJournalKeys {
		return errors.New("journal key limit reached")
	}
	r := record{Key: key, ID: id, Outcome: outcome}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	if len(b) > 1024 || j.bytes+int64(len(b)) > maxJournalBytes {
		return errors.New("journal size limit reached")
	}
	n, err := j.file.Write(b)
	if err != nil {
		return err
	}
	if n != len(b) {
		return fmt.Errorf("journal short write")
	}
	if err = j.file.Sync(); err != nil {
		return err
	}
	j.bytes += int64(n)
	j.records[key] = r
	return nil
}
