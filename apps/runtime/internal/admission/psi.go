package admission

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// IOPressureFile is where Linux publishes I/O pressure stall information.
const IOPressureFile = "/proc/pressure/io"

// FilePressure reads io "some" avg10 from path on each call. The file is a few bytes and the
// kernel serves it from memory, so reading it once a second per waiting Attempt costs nothing.
func FilePressure(path string) Pressure {
	return func() (float64, error) {
		content, err := os.ReadFile(path)
		if err != nil {
			return 0, err
		}
		return ParseSomeAvg10(string(content))
	}
}

// ParseSomeAvg10 returns the avg10 field of the "some" line of a PSI file:
//
//	some avg10=4.03 avg60=6.77 avg300=10.64 total=5945908642
//	full avg10=4.02 avg60=6.71 avg300=10.18 total=5720730406
func ParseSomeAvg10(content string) (float64, error) {
	for line := range strings.SplitSeq(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || fields[0] != "some" {
			continue
		}
		for _, field := range fields[1:] {
			value, ok := strings.CutPrefix(field, "avg10=")
			if !ok {
				continue
			}
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil || parsed < 0 || parsed > 100 {
				return 0, fmt.Errorf("pressure: avg10 %q is not a percentage", value)
			}
			return parsed, nil
		}
		return 0, fmt.Errorf("pressure: some line has no avg10: %q", line)
	}
	return 0, fmt.Errorf("pressure: no some line in %q", content)
}
