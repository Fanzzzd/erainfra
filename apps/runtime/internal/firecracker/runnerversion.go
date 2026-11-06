package firecracker

import (
	"regexp"
	"strconv"
	"strings"

	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

// RunnerVersionLabel is the image label that names the actions/runner release
// installed in the image. images/ubuntu-24.04-js/Dockerfile sets it from ARG
// RUNNER_VERSION, so the pin bump that moves the ARG moves the label too.
const RunnerVersionLabel = "dev.erainfra.actions-runner.version"

const runnerVersionArg = "RUNNER_VERSION"

var runnerVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// imageRunnerVersion reads which actions/runner release an image carries, or
// "" when the image does not say. Every Runner here registers with automatic
// updates off, and GitHub stops queueing jobs to such a Runner 30 days after
// the next release is published, so the control plane needs this to warn
// before that happens.
//
// Three places are read, the most explicit first: the label; a RUNNER_VERSION
// environment variable (an image built from actions/runner's own Dockerfile
// may set one); and the build arguments BuildKit records in each RUN step's
// history ("RUN |3 TARGETARCH=amd64 RUNNER_VERSION=2.336.0 ... /bin/sh -c ...").
// The history fallback is what lets an image built before the label existed
// still report its version. A value that is not x.y.z is ignored.
func imageRunnerVersion(image ocispec.Image) string {
	if version := strings.TrimSpace(image.Config.Labels[RunnerVersionLabel]); runnerVersionPattern.MatchString(version) {
		return version
	}
	for _, entry := range image.Config.Env {
		name, value, ok := strings.Cut(entry, "=")
		if ok && name == runnerVersionArg && runnerVersionPattern.MatchString(value) {
			return value
		}
	}
	for index := len(image.History) - 1; index >= 0; index-- {
		if version := buildArgRunnerVersion(image.History[index].CreatedBy); version != "" {
			return version
		}
	}
	return ""
}

// buildArgRunnerVersion reads RUNNER_VERSION from the build arguments BuildKit
// lists before a RUN step's command: "RUN |<n> <name>=<value> ... <command>".
// Only those n words are read, so a command that itself mentions
// RUNNER_VERSION= is never mistaken for the argument.
func buildArgRunnerVersion(createdBy string) string {
	fields := strings.Fields(createdBy)
	if len(fields) < 2 || fields[0] != "RUN" || !strings.HasPrefix(fields[1], "|") {
		return ""
	}
	count, err := strconv.Atoi(strings.TrimPrefix(fields[1], "|"))
	if err != nil || count < 1 || count > len(fields)-2 {
		return ""
	}
	for _, field := range fields[2 : 2+count] {
		name, value, ok := strings.Cut(field, "=")
		if ok && name == runnerVersionArg && runnerVersionPattern.MatchString(value) {
			return value
		}
	}
	return ""
}
