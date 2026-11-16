package admission

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// IOPressureFile is where Linux publishes I/O pressure stall information.
const IOPressureFile = "/proc/pressure/io"

// FilePressure reads io "some" pressure from path on each call. The file is a few bytes and the
// kernel serves it from memory, so reading it once a second per waiting Attempt costs nothing.
func FilePressure(path string) Pressure {
	return func() (PSI, error) {
		content, err := os.ReadFile(path)
		if err != nil {
			return PSI{}, err
		}
		return ParseSome(string(content))
	}
}

// ParseSome returns the avg10 and total fields of the "some" line of a PSI file. total is in
// microseconds:
//
//	some avg10=4.03 avg60=6.77 avg300=10.64 total=5945908642
//	full avg10=4.02 avg60=6.71 avg300=10.18 total=5720730406
func ParseSome(content string) (PSI, error) {
	for line := range strings.SplitSeq(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "some" {
			continue
		}
		var reading PSI
		var haveAvg, haveTotal bool
		for _, field := range fields[1:] {
			if value, ok := strings.CutPrefix(field, "avg10="); ok {
				parsed, err := strconv.ParseFloat(value, 64)
				if err != nil || parsed < 0 || parsed > 100 {
					return PSI{}, fmt.Errorf("pressure: avg10 %q is not a percentage", value)
				}
				reading.Avg10, haveAvg = parsed, true
			}
			if value, ok := strings.CutPrefix(field, "total="); ok {
				parsed, err := strconv.ParseUint(value, 10, 63)
				if err != nil {
					return PSI{}, fmt.Errorf("pressure: total %q is not a count of microseconds", value)
				}
				reading.Total, haveTotal = time.Duration(parsed)*time.Microsecond, true
			}
		}
		if !haveAvg || !haveTotal {
			return PSI{}, fmt.Errorf("pressure: some line lacks avg10 or total: %q", line)
		}
		return reading, nil
	}
	return PSI{}, fmt.Errorf("pressure: no some line in %q", content)
}
