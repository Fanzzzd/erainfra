package firecracker

import (
	"testing"

	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
)

func TestImageRunnerVersion(t *testing.T) {
	// What BuildKit records for images/ubuntu-24.04-js's runner install step,
	// abridged: the build arguments in scope, then the shell command.
	installStep := "RUN |7 TARGETARCH=amd64 RUNNER_VERSION=2.336.0 NODE_VERSION=22.23.2 NODE_24_VERSION=24.22.1 " +
		"PNPM_VERSION=11.21.0 GO_VERSION=1.27.3 GH_VERSION=2.97.0 /bin/sh -c set -eux; curl " +
		"https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner.tar.gz # buildkit"
	for _, test := range []struct {
		name  string
		image ocispec.Image
		want  string
	}{
		{
			name: "label wins over history",
			image: ocispec.Image{
				Config:  ocispec.ImageConfig{Labels: map[string]string{RunnerVersionLabel: "2.338.2"}},
				History: []ocispec.History{{CreatedBy: installStep}},
			},
			want: "2.338.2",
		},
		{
			name:  "environment variable",
			image: ocispec.Image{Config: ocispec.ImageConfig{Env: []string{"PATH=/usr/bin", "RUNNER_VERSION=2.337.0"}}},
			want:  "2.337.0",
		},
		{
			// The incident image: built before the label, pinned to 2.336.0.
			name: "BuildKit build argument in history",
			image: ocispec.Image{History: []ocispec.History{
				{CreatedBy: "ARG RUNNER_VERSION=2.336.0", EmptyLayer: true},
				{CreatedBy: installStep},
				{CreatedBy: "RUN |7 TARGETARCH=amd64 RUNNER_VERSION=2.336.0 /bin/sh -c chmod 0755 x # buildkit"},
			}},
			want: "2.336.0",
		},
		{
			name: "a command that mentions RUNNER_VERSION is not an argument",
			image: ocispec.Image{History: []ocispec.History{
				{CreatedBy: "RUN |1 TARGETARCH=amd64 /bin/sh -c echo RUNNER_VERSION=9.9.9"},
				{CreatedBy: "/bin/sh -c #(nop) RUNNER_VERSION=8.8.8"},
			}},
			want: "",
		},
		{
			name: "malformed values are ignored",
			image: ocispec.Image{
				Config:  ocispec.ImageConfig{Labels: map[string]string{RunnerVersionLabel: "latest"}},
				History: []ocispec.History{{CreatedBy: "RUN |9 RUNNER_VERSION=2.336.0"}, {CreatedBy: "RUN |1 RUNNER_VERSION=v2"}},
			},
			want: "",
		},
		{name: "nothing to read", image: ocispec.Image{}, want: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := imageRunnerVersion(test.image); got != test.want {
				t.Fatalf("imageRunnerVersion = %q, want %q", got, test.want)
			}
		})
	}
}
