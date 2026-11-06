package testreport

import (
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// ErrNotJUnit is returned for a well-formed file whose root element is
// neither <testsuites> nor <testsuite>. The collector skips such a file
// quietly: a glob such as **/test-results/**/*.xml matches more than JUnit.
var ErrNotJUnit = errors.New("not a JUnit XML document")

// maxDepth bounds element nesting. Real reports nest testsuites a few levels
// deep; anything past this is a file built to exhaust the parser.
const maxDepth = 64

// parsedCase is one <testcase> element as written, before the cases of an
// Attempt are merged by id.
type parsedCase struct {
	Suite      string
	Name       string
	File       string
	Status     Status
	DurationMs int64
	Message    string
	// Retries counts flakyFailure and flakyError children: failed runs of a
	// case that then passed (Maven Surefire's rerunFailingTestsCount).
	Retries int
}

type suiteFrame struct {
	name string
	file string
}

// ParseJUnit reads one JUnit XML document and returns at most maxCases
// cases, and whether it stopped early because of that bound.
//
// It understands the dialects CI tools write: jest-junit, Vitest's junit
// reporter, pytest's --junitxml, gotestsum's --junitfile and Maven Surefire
// (including its flakyFailure and rerunFailure elements). Unknown elements
// and attributes are ignored.
//
// encoding/xml is safe against the attacks a hostile file carries: it never
// resolves an external entity or fetches a DTD, it refuses any entity it does
// not know (so neither XXE nor entity expansion "billion laughs" is
// possible), and it refuses an encoding other than UTF-8 because no
// CharsetReader is installed. Nesting is bounded here, and the caller bounds
// the bytes.
func ParseJUnit(reader io.Reader, maxCases int) ([]parsedCase, bool, error) {
	decoder := xml.NewDecoder(reader)
	decoder.Strict = true
	var (
		cases    []parsedCase
		suites   []suiteFrame
		current  *parsedCase
		depth    int
		rooted   bool
		textInto *strings.Builder
		text     strings.Builder
		// replaceable says the open outcome element decides the case's
		// message and its attribute left the body room to say more.
		replaceable bool
	)
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			if !rooted {
				return nil, false, ErrNotJUnit
			}
			return cases, false, nil
		}
		if err != nil {
			return nil, false, fmt.Errorf("parse JUnit XML: %w", err)
		}
		switch element := token.(type) {
		case xml.StartElement:
			depth++
			if depth > maxDepth {
				return nil, false, fmt.Errorf("JUnit XML nests deeper than %d elements", maxDepth)
			}
			name := element.Name.Local
			if !rooted {
				if name != "testsuites" && name != "testsuite" {
					return nil, false, ErrNotJUnit
				}
				rooted = true
			}
			switch {
			case name == "testsuite":
				suites = append(suites, suiteFrame{
					name: attribute(element, "name"),
					file: attribute(element, "file"),
				})
			case name == "testcase" && current == nil:
				if len(cases) >= maxCases {
					return cases, true, nil
				}
				current = startCase(element, suites)
			case current != nil && isOutcome(name):
				textInto, replaceable = applyOutcome(current, element, &text)
			}
		case xml.EndElement:
			depth--
			switch {
			case element.Name.Local == "testsuite" && len(suites) > 0:
				suites = suites[:len(suites)-1]
			case element.Name.Local == "testcase" && current != nil:
				cases = append(cases, finishCase(*current))
				current = nil
				textInto, replaceable = nil, false
			case textInto != nil && isOutcome(element.Name.Local):
				if body := firstLines(text.String()); replaceable && body != "" {
					current.Message = body
				}
				textInto, replaceable = nil, false
			}
		case xml.CharData:
			// Only an outcome's own text is kept, and only enough of it for a
			// message: system-out can be megabytes and is never stored.
			if textInto != nil && textInto.Len() < 4*MaxMessageBytes {
				textInto.Write(element[:min(len(element), 4*MaxMessageBytes-textInto.Len())])
			}
		}
	}
}

func attribute(element xml.StartElement, name string) string {
	for _, attr := range element.Attr {
		if attr.Name.Local == name {
			return attr.Value
		}
	}
	return ""
}

func startCase(element xml.StartElement, suites []suiteFrame) *parsedCase {
	name := attribute(element, "name")
	suite := attribute(element, "classname")
	file := attribute(element, "file")
	if len(suites) > 0 {
		enclosing := suites[len(suites)-1]
		// jest-junit writes the test's full title as both classname and name
		// by default, so the enclosing suite is the more useful grouping.
		if suite == "" || suite == name {
			suite = enclosing.name
		}
		if file == "" {
			file = enclosing.file
		}
	}
	return &parsedCase{
		Suite:      suite,
		Name:       name,
		File:       file,
		Status:     StatusPassed,
		DurationMs: parseSeconds(attribute(element, "time")),
	}
}

func isOutcome(name string) bool {
	switch name {
	case "failure", "error", "skipped", "flakyFailure", "flakyError", "rerunFailure", "rerunError":
		return true
	}
	return false
}

// applyOutcome folds one child of a <testcase> into it. It returns the
// builder the child's text is collected into, and whether that text may
// become the case's message: it may when this child decides the message and
// its message attribute is missing or a placeholder such as gotestsum's
// "Failed", which says less than the output beneath it.
func applyOutcome(current *parsedCase, element xml.StartElement, text *strings.Builder) (*strings.Builder, bool) {
	name := element.Name.Local
	decides := false
	switch name {
	case "failure", "error":
		status := StatusFailed
		if name == "error" {
			status = StatusErrored
		}
		// A failure outranks an error outranks a skip; the first message of
		// the outcome that decides the status is the one kept.
		if current.Status != StatusFailed && (current.Status != StatusErrored || status == StatusFailed) {
			current.Status = status
			current.Message = attribute(element, "message")
			decides = true
		}
	case "skipped":
		if current.Status == StatusPassed {
			current.Status = StatusSkipped
			current.Message = attribute(element, "message")
			decides = true
		}
	case "flakyFailure", "flakyError":
		current.Retries++
		if current.Status == StatusPassed && current.Message == "" {
			current.Message = attribute(element, "message")
			decides = true
		}
	}
	// rerunFailure and rerunError are failed reruns of a case that failed
	// overall; the case's own failure element already decided its status.
	text.Reset()
	return text, decides && placeholder(current.Message)
}

// placeholder reports a message attribute too thin to keep over the
// element's body: empty, or one short word.
func placeholder(message string) bool {
	message = strings.TrimSpace(message)
	return len(message) < 12 && !strings.ContainsAny(message, " :")
}

func finishCase(current parsedCase) parsedCase {
	current.Name = cleanText(current.Name, MaxNameBytes)
	current.Suite = cleanText(current.Suite, MaxNameBytes)
	current.File = cleanText(current.File, MaxNameBytes)
	current.Message = cleanText(current.Message, MaxMessageBytes)
	if current.Status == StatusPassed && current.Retries == 0 {
		current.Message = ""
	}
	return current
}

// firstLines keeps the head of a failure's body: the assertion, not the
// whole stack.
func firstLines(body string) string {
	lines := strings.Split(strings.TrimSpace(body), "\n")
	if len(lines) > 8 {
		lines = lines[:8]
	}
	return strings.Join(lines, "\n")
}

// parseSeconds reads a time attribute. Surefire writes thousands separators
// in some locales ("1,234.5"); anything unparseable, negative or not finite
// counts as zero rather than failing the file.
func parseSeconds(value string) int64 {
	value = strings.ReplaceAll(strings.TrimSpace(value), ",", "")
	if value == "" {
		return 0
	}
	seconds, err := strconv.ParseFloat(value, 64)
	if err != nil || math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds <= 0 {
		return 0
	}
	ms := math.Round(seconds * 1000)
	if ms > MaxDurationMs {
		return MaxDurationMs
	}
	return int64(ms)
}
