package main

import (
	"fmt"
	"strconv"
	"strings"
)

// version is a dotted numeric release number: 2.338.2, 1.25.3, 24.22.1. Every
// pin this tool moves uses one, and nothing it moves to may carry a
// pre-release suffix.
type version []int

func parseVersion(s string) (version, error) {
	s = strings.TrimPrefix(s, "v")
	parts := strings.Split(s, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return nil, fmt.Errorf("%q is not a MAJOR.MINOR[.PATCH] version", s)
	}
	v := make(version, len(parts))
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 || part == "" || (len(part) > 1 && part[0] == '0') {
			return nil, fmt.Errorf("%q is not a MAJOR.MINOR[.PATCH] version", s)
		}
		v[i] = n
	}
	return v, nil
}

func (v version) at(i int) int {
	if i < len(v) {
		return v[i]
	}
	return 0
}

func (v version) compare(o version) int {
	for i := 0; i < 3; i++ {
		switch {
		case v.at(i) < o.at(i):
			return -1
		case v.at(i) > o.at(i):
			return 1
		}
	}
	return 0
}

func (v version) String() string {
	parts := make([]string, len(v))
	for i, n := range v {
		parts[i] = strconv.Itoa(n)
	}
	return strings.Join(parts, ".")
}

// checkNotOlder refuses to move a pin backwards. Upstream's "latest" moving
// backwards is either a retracted release or a tampered response, and neither
// is something to commit on a schedule.
func checkNotOlder(name, current, latest string) error {
	cur, err := parseVersion(current)
	if err != nil {
		return fmt.Errorf("current %s pin: %w", name, err)
	}
	next, err := parseVersion(latest)
	if err != nil {
		return fmt.Errorf("upstream %s: %w", name, err)
	}
	if next.compare(cur) < 0 {
		return fmt.Errorf("upstream's newest %s is %s, older than the pinned %s; refusing to downgrade", name, latest, current)
	}
	return nil
}
