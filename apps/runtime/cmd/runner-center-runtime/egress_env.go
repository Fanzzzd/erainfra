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
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/runnerexit"
	"github.com/Fanzzzd/erainfra/apps/runtime/internal/testreport"
	"github.com/Fanzzzd/erainfra/internal/dualenv"
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
	value := strings.TrimSpace(dualenv.Value(profileEgressVariable))
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
	if record == nil {
		return nil
	}
	return writeRecordFile(egressRecordVariable, "egress record", record)
}

// writeRecordFile writes value as JSON to the absolute path the variable
// names, creating the file fresh and owner-only, or does nothing when the
// variable is unset.
func writeRecordFile(variable, what string, value any) error {
	path := strings.TrimSpace(dualenv.Value(variable))
	if path == "" {
		return nil
	}
	if !filepath.IsAbs(path) {
		return errors.New(variable + " must be an absolute path")
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s: %w", what, err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write %s: %w", what, err)
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return fmt.Errorf("write %s: %w", what, err)
	}
	return file.Close()
}

// testReportVariable names the file `run` writes the Attempt's JUnit results
// to, for the Worker to report to the control plane.
const testReportVariable = "RC_TEST_REPORT_FILE"

// writeTestReport writes the Attempt's test results where
// RC_TEST_REPORT_FILE says, or does nothing when it is unset or the guest
// reported none.
func writeTestReport(report *testreport.Report) error {
	if report == nil {
		return nil
	}
	return writeRecordFile(testReportVariable, "test report", report)
}

// runnerExitVariable names the file `run` writes how the Attempt's GitHub
// runner ended to, for the Worker to report with the Attempt.
const runnerExitVariable = "RC_RUNNER_EXIT_FILE"

// writeRunnerExit writes the guest's runner exit report where
// RC_RUNNER_EXIT_FILE says, or does nothing when it is unset or the guest
// reported none.
func writeRunnerExit(report *runnerexit.Report) error {
	if report == nil {
		return nil
	}
	return writeRecordFile(runnerExitVariable, "runner exit report", report)
}
