package testreport

import (
	"sort"
	"strings"
)

type mergedCase struct {
	testCase Case
	passes   int
	failures int
	errors   int
	retries  int
}

var statusRank = map[Status]int{StatusFailed: 0, StatusErrored: 1, StatusFlaky: 2}

// Build merges parsed cases by id into a report. A test that appears more
// than once in an Attempt -- a rerun, or the same suite in two files -- is one
// case: flaky when it both failed and passed, otherwise its worst outcome.
func Build(parsed []parsedCase) *Report {
	byID := make(map[string]*mergedCase)
	for _, current := range parsed {
		if current.Name == "" {
			continue
		}
		id := CaseID(current.Suite, current.Name)
		merged := byID[id]
		if merged == nil {
			merged = &mergedCase{testCase: Case{
				ID:    id,
				Suite: current.Suite,
				Name:  current.Name,
				File:  current.File,
			}}
			byID[id] = merged
		}
		switch current.Status {
		case StatusPassed:
			merged.passes++
		case StatusFailed:
			merged.failures++
		case StatusErrored:
			merged.errors++
		}
		merged.retries += current.Retries
		merged.testCase.DurationMs = max(merged.testCase.DurationMs, current.DurationMs)
		failing := current.Status == StatusFailed || current.Status == StatusErrored || current.Retries > 0
		if failing && merged.testCase.Message == "" {
			merged.testCase.Message = current.Message
		}
	}

	report := &Report{Version: Version, Cases: []Case{}}
	var notable, passed []Case
	for _, merged := range byID {
		testCase := merged.testCase
		bad := merged.failures + merged.errors
		switch {
		case merged.passes > 0 && (bad > 0 || merged.retries > 0):
			testCase.Status = StatusFlaky
			testCase.Retries = min(bad+merged.retries, 1000)
			report.Totals.Flaky++
		case merged.failures > 0:
			testCase.Status = StatusFailed
			report.Totals.Failed++
		case merged.errors > 0:
			testCase.Status = StatusErrored
			report.Totals.Errored++
		case merged.passes > 0:
			testCase.Status = StatusPassed
			testCase.Message = ""
			report.Totals.Passed++
		default:
			testCase.Status = StatusSkipped
			report.Totals.Skipped++
		}
		report.Totals.Tests++
		report.Totals.DurationMs = min(report.Totals.DurationMs+testCase.DurationMs, int64(MaxTotal)*1000)
		switch testCase.Status {
		case StatusPassed:
			passed = append(passed, testCase)
		case StatusSkipped:
		default:
			notable = append(notable, testCase)
		}
	}

	sort.Slice(notable, func(i, j int) bool {
		if statusRank[notable[i].Status] != statusRank[notable[j].Status] {
			return statusRank[notable[i].Status] < statusRank[notable[j].Status]
		}
		return notable[i].ID < notable[j].ID
	})
	if len(notable) > MaxCases {
		notable = notable[:MaxCases]
		report.Truncated = true
	}
	report.Cases = append(report.Cases, notable...)

	sort.Slice(passed, func(i, j int) bool {
		if passed[i].DurationMs != passed[j].DurationMs {
			return passed[i].DurationMs > passed[j].DurationMs
		}
		return passed[i].ID < passed[j].ID
	})
	for _, testCase := range passed {
		if len(report.Cases) >= MaxCases || len(report.Cases)-len(notable) >= MaxSlowest || testCase.DurationMs == 0 {
			break
		}
		report.Cases = append(report.Cases, testCase)
	}

	hashes := make(map[string]struct{}, len(passed))
	for _, testCase := range passed {
		hashes[PassedHash(testCase.ID)] = struct{}{}
	}
	sorted := make([]string, 0, len(hashes))
	for hash := range hashes {
		sorted = append(sorted, hash)
	}
	sort.Strings(sorted)
	if len(sorted) > MaxPassed {
		sorted = sorted[:MaxPassed]
		report.Truncated = true
	}
	report.Passed = strings.Join(sorted, "")
	return report
}
