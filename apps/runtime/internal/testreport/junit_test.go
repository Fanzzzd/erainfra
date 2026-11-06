package testreport

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func parseFixture(t *testing.T, name string) []parsedCase {
	t.Helper()
	file, err := os.Open("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close() //nolint:errcheck // test fixture
	cases, cut, err := ParseJUnit(file, 1000)
	if err != nil {
		t.Fatalf("parse %s: %v", name, err)
	}
	if cut {
		t.Fatalf("parse %s: cut short", name)
	}
	return cases
}

func caseByID(t *testing.T, report *Report, id string) Case {
	t.Helper()
	for _, testCase := range report.Cases {
		if testCase.ID == id {
			return testCase
		}
	}
	t.Fatalf("no case %q in %+v", id, report.Cases)
	return Case{}
}

func TestJestJunitUsesTheSuiteWhenClassnameRepeatsTheTitle(t *testing.T) {
	report := Build(parseFixture(t, "jest-junit.xml"))
	if err := report.Validate(); err != nil {
		t.Fatal(err)
	}
	want := Totals{Tests: 4, Passed: 2, Failed: 1, Skipped: 1, DurationMs: 1066}
	if report.Totals != want {
		t.Fatalf("totals = %+v, want %+v", report.Totals, want)
	}
	failed := caseByID(t, report, "Calculator::Calculator divides by zero")
	if failed.Status != StatusFailed || failed.DurationMs != 812 {
		t.Fatalf("failed case = %+v", failed)
	}
	// jest-junit writes no message attribute, so the body's head is the message.
	if !strings.HasPrefix(failed.Message, "Error: expect(received).toThrow()\n\nReceived function did not throw") {
		t.Fatalf("message = %q", failed.Message)
	}
	// Markup in a name is carried as text; escaping it is the renderer's job.
	slow := caseByID(t, report, "Calculator::Calculator handles <script>alert(1)</script>")
	if slow.Status != StatusPassed || slow.DurationMs != 250 {
		t.Fatalf("slowest pass = %+v", slow)
	}
}

func TestVitestKeepsTheFailureMessageAttribute(t *testing.T) {
	report := Build(parseFixture(t, "vitest.xml"))
	failed := caseByID(t, report, "src/math.test.ts::math > subtracts")
	if failed.Message != "expected 2 to be 3 // Object.is equality" || failed.Status != StatusFailed {
		t.Fatalf("failed case = %+v", failed)
	}
	if report.Totals.Skipped != 1 || report.Totals.Passed != 1 {
		t.Fatalf("totals = %+v", report.Totals)
	}
}

func TestPytestSeparatesFailuresErrorsAndSkips(t *testing.T) {
	report := Build(parseFixture(t, "pytest.xml"))
	want := Totals{Tests: 5, Passed: 2, Failed: 1, Errored: 1, Skipped: 1, DurationMs: 105}
	if report.Totals != want {
		t.Fatalf("totals = %+v, want %+v", report.Totals, want)
	}
	errored := caseByID(t, report, "tests.test_api::test_db")
	if errored.Status != StatusErrored || !strings.Contains(errored.Message, "Connection refused") {
		t.Fatalf("errored case = %+v", errored)
	}
	failed := caseByID(t, report, "tests.test_api.TestClient::test_post[json]")
	if failed.Message != "AssertionError: assert 500 == 201" {
		t.Fatalf("failed case = %+v", failed)
	}
	// Failures come first, then errors, then the slowest passes.
	if report.Cases[0].Status != StatusFailed || report.Cases[1].Status != StatusErrored ||
		report.Cases[2].ID != "tests.test_api::test_slow" {
		t.Fatalf("case order = %+v", report.Cases)
	}
}

func TestGotestsumRerunMakesARetriedPassFlaky(t *testing.T) {
	report := Build(parseFixture(t, "gotestsum.xml"))
	race := caseByID(t, report, "github.com/example/app/store::TestRace")
	if race.Status != StatusFlaky || race.Retries != 1 || race.DurationMs != 1200 {
		t.Fatalf("rerun case = %+v", race)
	}
	if !strings.Contains(race.Message, "lost update") {
		t.Fatalf("flaky case keeps the failing run's message, got %q", race.Message)
	}
	broken := caseByID(t, report, "github.com/example/app/store::TestBroken")
	if broken.Status != StatusFailed {
		t.Fatalf("broken case = %+v", broken)
	}
	want := Totals{Tests: 5, Passed: 2, Failed: 1, Skipped: 1, Flaky: 1, DurationMs: 1610}
	if report.Totals != want {
		t.Fatalf("totals = %+v, want %+v", report.Totals, want)
	}
	if len(report.PassedHashes()) != 2 {
		t.Fatalf("passed hashes = %v", report.Passed)
	}
}

func TestSurefireFlakyFailureAndLocaleTimes(t *testing.T) {
	report := Build(parseFixture(t, "TEST-com.example.CalculatorTest.xml"))
	connects := caseByID(t, report, "com.example.CalculatorTest::connects")
	if connects.Status != StatusFlaky || connects.Retries != 1 || connects.Message != "Connection reset" {
		t.Fatalf("flakyFailure case = %+v", connects)
	}
	if connects.DurationMs != 1_200_500 {
		t.Fatalf("time with a thousands separator = %d ms", connects.DurationMs)
	}
	divides := caseByID(t, report, "com.example.CalculatorTest::divides")
	if divides.Status != StatusFailed || divides.Message != "expected: <2> but was: <3>" {
		t.Fatalf("rerunFailure must not change a failed case: %+v", divides)
	}
	boots := caseByID(t, report, "com.example.CalculatorTest::boots")
	if boots.Status != StatusErrored {
		t.Fatalf("error case = %+v", boots)
	}
}

func TestParserRefusesExternalEntities(t *testing.T) {
	secret := t.TempDir() + "/secret"
	if err := os.WriteFile(secret, []byte("TOP-SECRET"), 0o600); err != nil {
		t.Fatal(err)
	}
	documents := map[string]string{
		"external entity": `<?xml version="1.0"?>
<!DOCTYPE testsuite [<!ENTITY xxe SYSTEM "file://` + secret + `">]>
<testsuite name="s"><testcase name="&xxe;"/></testsuite>`,
		"parameter entity": `<?xml version="1.0"?>
<!DOCTYPE testsuite [<!ENTITY % remote SYSTEM "http://127.0.0.1:1/x.dtd"> %remote;]>
<testsuite name="s"><testcase name="a"><failure message="&send;"/></testcase></testsuite>`,
		"billion laughs": `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]>
<testsuite name="s"><testcase name="&lol3;"/></testsuite>`,
	}
	for name, document := range documents {
		t.Run(name, func(t *testing.T) {
			started := time.Now()
			cases, _, err := ParseJUnit(strings.NewReader(document), 100)
			if err == nil {
				t.Fatalf("parsed %+v; an undefined entity must fail the file", cases)
			}
			if strings.Contains(err.Error(), "TOP-SECRET") {
				t.Fatal("the error leaked the file the entity named")
			}
			if time.Since(started) > 2*time.Second {
				t.Fatal("the parser spent seconds on an entity document")
			}
		})
	}
}

func TestParserRefusesWhatIsNotJUnit(t *testing.T) {
	for name, document := range map[string]string{
		"other root": `<project><modelVersion>4.0.0</modelVersion></project>`,
		"empty":      ``,
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := ParseJUnit(strings.NewReader(document), 10); !errors.Is(err, ErrNotJUnit) {
				t.Fatalf("err = %v, want ErrNotJUnit", err)
			}
		})
	}
	deep := "<testsuites>" + strings.Repeat("<testsuite>", maxDepth+1) + strings.Repeat("</testsuite>", maxDepth+1) + "</testsuites>"
	if _, _, err := ParseJUnit(strings.NewReader(deep), 10); err == nil || errors.Is(err, ErrNotJUnit) {
		t.Fatalf("nesting past %d must fail, err = %v", maxDepth, err)
	}
	latin1 := `<?xml version="1.0" encoding="ISO-8859-1"?><testsuite name="s"><testcase name="a"/></testsuite>`
	if _, _, err := ParseJUnit(strings.NewReader(latin1), 10); err == nil {
		t.Fatal("a non-UTF-8 encoding must fail rather than be guessed")
	}
}

func TestParserStopsAtTheCaseBound(t *testing.T) {
	document := "<testsuite name=\"s\">" + strings.Repeat("<testcase name=\"a\"/>", 20) + "</testsuite>"
	cases, cut, err := ParseJUnit(strings.NewReader(document), 5)
	if err != nil || !cut || len(cases) != 5 {
		t.Fatalf("cases = %d, cut = %v, err = %v", len(cases), cut, err)
	}
}

func TestCleanTextDropsControlCharactersAndBoundsLength(t *testing.T) {
	cleaned := cleanText("a\x00b\x1b[31mc\u0085d\ne\xff", 100)
	if cleaned != "ab[31mcd\ne�" {
		t.Fatalf("cleaned = %q", cleaned)
	}
	long := cleanText(strings.Repeat("é", 600), MaxNameBytes)
	if len(long) > MaxNameBytes || !strings.HasSuffix(long, "é") {
		t.Fatalf("truncation broke a rune or the bound: %d bytes", len(long))
	}
}

func TestCaseIDKeepsLongIDsDistinct(t *testing.T) {
	prefix := strings.Repeat("x", 600)
	first, second := CaseID("suite", prefix+"a"), CaseID("suite", prefix+"b")
	if first == second || len(first) > MaxIDBytes || len(second) > MaxIDBytes {
		t.Fatalf("long ids collide or overflow: %d %d", len(first), len(second))
	}
	if CaseID("", "name") != "name" || CaseID("s", "n") != "s::n" {
		t.Fatal("short ids are suite::name")
	}
	// The control plane computes the same value (testReportsModel.ts passedHash), and its test
	// asserts this exact string too.
	if got := PassedHash("abc"); got != "ba7816bf8f01" {
		t.Fatalf("PassedHash(abc) = %q", got)
	}
}
