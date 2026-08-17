package agent

import (
	"os"
	"strings"
	"testing"
)

func TestValidateDockerArgsRejectsPrivilegeAndHostEscapeFlagsInEverySyntax(t *testing.T) {
	cases := map[string][]string{
		"privileged":             {"--privileged"},
		"privileged split value": {"--privileged", "true"},
		"privileged combined":    {"--privileged=true"},
		"host network split":     {"--network", "host"},
		"host network combined":  {"--network=host"},
		"host net alias":         {"--net=host"},
		"host net alias split":   {"--net", "host"},
		"host pid split":         {"--pid", "host"},
		"host pid combined":      {"--pid=host"},
		"host ipc split":         {"--ipc", "host"},
		"host ipc combined":      {"--ipc=host"},
		"device split":           {"--device", "/dev/kvm"},
		"device combined":        {"--device=/dev/kvm"},
		"capability split":       {"--cap-add", "SYS_ADMIN"},
		"capability combined":    {"--cap-add=SYS_ADMIN"},
		"security opt split":     {"--security-opt", "seccomp=unconfined"},
		"security opt combined":  {"--security-opt=seccomp=unconfined"},
		"host bind short split":  {"-v", "/:/host"},
		"host bind short equals": {"-v=/:/host"},
		"host bind long split":   {"--volume", "/etc:/host"},
		"host bind long equals":  {"--volume=/etc:/host"},
		"docker socket short":    {"-v", "/var/run/docker.sock:/var/run/docker.sock"},
		"docker socket long":     {"--volume=/var/run/docker.sock:/sock"},
		"bind mount split":       {"--mount", "type=bind,source=/,target=/host"},
		"bind mount combined":    {"--mount=type=bind,source=/,target=/host"},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			if err := validateDockerArgs(args); err == nil {
				t.Fatalf("dangerous docker args accepted: %q", args)
			}
		})
	}
}

func TestValidateDockerArgsPreservesSafeDeployments(t *testing.T) {
	args := []string{
		"-e", "PORT=8080",
		"-p", "127.0.0.1:8080:80",
		"--publish=9090:90",
		"-v", "myapp-data:/var/lib/data",
		"--volume=myapp-cache:/cache:ro",
		"--add-host=host.docker.internal:host-gateway",
	}
	if err := validateDockerArgs(args); err != nil {
		t.Fatalf("safe deployment rejected: %v", err)
	}
}

func TestRunCmdRejectsHostSentinelMountBeforeRunner(t *testing.T) {
	sentinel := t.TempDir() + "/host-secret"
	const secret = "HOST_SENTINEL_DO_NOT_EXPOSE"
	if err := os.WriteFile(sentinel, []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	called := false
	reply := RunCmd(
		cmdMsg{ID: "sentinel", Cmd: "deploy", Image: "busybox", Name: "probe", Args: []string{"-v", sentinel + ":/sentinel"}},
		fakeRunner{depOut: secret, deployCalled: &called},
	)
	if reply.OK || called || strings.Contains(reply.Output, secret) {
		t.Fatalf("host sentinel path reached the runner: reply=%+v called=%v", reply, called)
	}
}
