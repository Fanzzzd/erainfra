package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Fanzzzd/erainfra/apps/runtime/internal/executor"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/netpolicy"
)

// profileEgressVariable carries the Profile's egress from the Worker to every
// command that acts for a Profile. It is deliberately not RC_EGRESS_MODE:
// that name is the host operator's override in runtime.env, read by the
// daemon, and an Agent that happens to run with it set must not be able to
// change what a Profile asks for.
const profileEgressVariable = "RC_PROFILE_EGRESS"

// egressRecordVariable names the file `run` writes the Attempt's egress record
// to, for the Worker to report with the Attempt.
const egressRecordVariable = "RC_EGRESS_RECORD_FILE"

const maxProfileEgressBytes = 64 << 10

// profileEgressEnv reads RC_PROFILE_EGRESS. Unset or empty is public egress,
// which is what a Worker that predates Profile egress sends; anything else
// must be a valid policy, because silently falling back to public for a
// Profile that asked for an allowlist would be failing open.
func profileEgressEnv() (netpolicy.ProfileEgress, error) {
	value := strings.TrimSpace(os.Getenv(profileEgressVariable))
	if value == "" {
		return netpolicy.ProfileEgress{}, nil
	}
	if len(value) > maxProfileEgressBytes {
		return netpolicy.ProfileEgress{}, fmt.Errorf("%s exceeds 64 KiB", profileEgressVariable)
	}
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	var egress netpolicy.ProfileEgress
	if err := decoder.Decode(&egress); err != nil {
		return netpolicy.ProfileEgress{}, fmt.Errorf("%s is not a Profile egress policy: %w", profileEgressVariable, err)
	}
	if err := egress.Validate(); err != nil {
		return netpolicy.ProfileEgress{}, fmt.Errorf("%s: %w", profileEgressVariable, err)
	}
	return egress.Normalized(), nil
}

// writeEgressRecord writes the record where RC_EGRESS_RECORD_FILE says, or
// does nothing when it is unset or there is no record. The file is created
// fresh and owner-only: it names what a job connected to.
func writeEgressRecord(record *executor.EgressRecord) error {
	path := strings.TrimSpace(os.Getenv(egressRecordVariable))
	if path == "" || record == nil {
		return nil
	}
	if !filepath.IsAbs(path) {
		return errors.New(egressRecordVariable + " must be an absolute path")
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode egress record: %w", err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write egress record: %w", err)
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return fmt.Errorf("write egress record: %w", err)
	}
	return file.Close()
}
