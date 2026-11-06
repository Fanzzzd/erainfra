package testreport

import (
	"context"
	"errors"
	"math/rand/v2"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// matchByEverySplit is the matcher matchSegments replaced: it tries every split
// point for every **, which is exact and exponential in the number of **. It is
// the reference the linear matcher must agree with.
func matchByEverySplit(pattern, name []string) bool {
	for len(pattern) > 0 {
		if pattern[0] == "**" {
			for len(pattern) > 0 && pattern[0] == "**" {
				pattern = pattern[1:]
			}
			if len(pattern) == 0 {
				return true
			}
			for skip := 0; skip <= len(name); skip++ {
				if matchByEverySplit(pattern, name[skip:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		if matched, err := path.Match(pattern[0], name[0]); err != nil || !matched {
			return false
		}
		pattern, name = pattern[1:], name[1:]
	}
	return len(name) == 0
}

func TestMatchSegmentsAgreesWithTryingEverySplit(t *testing.T) {
	random := rand.New(rand.NewPCG(1, 2))
	patternSegments := []string{"**", "**", "a", "b", "*", "a*", "?", "[ab]", "x.xml", "*.xml"}
	nameSegments := []string{"a", "b", "ab", "ba", "x.xml", "y.xml", "c"}
	for range 20_000 {
		pattern := make([]string, 1+random.IntN(6))
		for index := range pattern {
			pattern[index] = patternSegments[random.IntN(len(patternSegments))]
		}
		name := make([]string, 1+random.IntN(7))
		for index := range name {
			name[index] = nameSegments[random.IntN(len(nameSegments))]
		}
		want := matchByEverySplit(pattern, name)
		got, err := matchSegments(context.Background(), pattern, name)
		if err != nil || got != want {
			t.Fatalf("matchSegments(%q, %q) = %v, %v; want %v",
				strings.Join(pattern, "/"), strings.Join(name, "/"), got, err, want)
		}
	}
}

func TestMatchSegmentsIsLinearInTheNumberOfStars(t *testing.T) {
	// Four ** against a path a little under PATH_MAX deep, with no match: the
	// old matcher made about depth^4 comparisons here.
	pattern := strings.Split("**/x/**/x/**/x/**/y.xml", "/")
	name := strings.Split(strings.Repeat("x/", 2000)+"z.xml", "/")
	start := time.Now()
	matched, err := matchSegments(context.Background(), pattern, name)
	if err != nil || matched {
		t.Fatalf("matchSegments = %v, %v", matched, err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("one match took %s", elapsed)
	}
}

func TestMatchSegmentsStopsWhenTheBudgetIsSpent(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	pattern := strings.Split("**/x/**/y.xml", "/")
	name := strings.Split(strings.Repeat("x/", 2000)+"z.xml", "/")
	if _, err := matchSegments(ctx, pattern, name); !errors.Is(err, context.Canceled) {
		t.Fatalf("matchSegments under a spent budget = %v, want context.Canceled", err)
	}
}

// A repository's own pattern is the job's to write, and so is its tree. A
// pattern with the most ** allowed against one deep path must not hold
// collection past its budget.
func TestCollectHonoursItsBudgetAgainstADeepPath(t *testing.T) {
	work := t.TempDir()
	workspace := filepath.Join(work, "repo", "repo")
	writeFile(t, filepath.Join(workspace, ConfigFile), "**/x/**/x/**/x/**/y.xml\n")
	deep := filepath.Join(workspace, strings.Repeat("x/", 400))
	writeFile(t, filepath.Join(deep, "z.xml"), "<testsuite/>")
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = Collector{WorkDir: work, Budget: time.Second}.Collect(context.Background())
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("Collect with a one-second budget is still running after 15 seconds")
	}
	if _, err := os.Stat(filepath.Join(deep, "z.xml")); err != nil {
		t.Fatal(err)
	}
}
