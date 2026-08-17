package agent

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Docker args remain a compatibility surface for existing safe deployments, but they are parsed
// here at the node trust boundary and rendered only from a small allowlist. Unknown flags fail
// closed; in particular there is no syntax that can request host namespaces, devices, elevated
// capabilities, security-profile changes, bind mounts, or host sockets.
//
// The Hub applies the same policy before this ever runs. "The same" is asserted, not assumed:
// testdata/dockerargs-cases.json is read as a table test by dockerargs_conformance_test.go here
// and by apps/hub/test/dockerargs.test.ts there. Any rule changed in this file has to be changed
// in both, or the fixture goes red.
var (
	dockerVolumeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	dockerEnvName    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	// Docker parses a port with strconv.ParseUint(raw, 10, 16): decimal digits, nothing else.
	dockerPortDigits = regexp.MustCompile(`^[0-9]+$`)
)

const dockerControlChars = "\x00\n\r"

func validateDockerArgs(args []string) error {
	if len(args) > 64 {
		return fmt.Errorf("docker args: at most 64 tokens")
	}
	for i := 0; i < len(args); i++ {
		flag := args[i]
		if flag == "" || len(flag) > 512 || strings.ContainsAny(flag, dockerControlChars) {
			return fmt.Errorf("docker args: invalid token")
		}
		value := ""
		// An `=`-joined flag carries its value even when that value is empty, so track
		// presence separately: treating `--env=` as "no value yet" would consume the next
		// token and validate it in a position Docker never reads it from.
		hasValue := false
		kind := ""
		switch flag {
		case "-p", "--publish":
			kind = "publish"
		case "-v", "--volume":
			kind = "volume"
		case "-e", "--env":
			kind = "env"
		case "--add-host":
			kind = "add-host"
		default:
			for prefix, candidate := range map[string]string{
				"-p=": "publish", "--publish=": "publish",
				"-v=": "volume", "--volume=": "volume",
				"-e=": "env", "--env=": "env",
				"--add-host=": "add-host",
			} {
				if strings.HasPrefix(flag, prefix) {
					kind = candidate
					value = strings.TrimPrefix(flag, prefix)
					hasValue = true
					break
				}
			}
			if kind == "" {
				return fmt.Errorf("docker args: flag %q is not allowed", flag)
			}
		}
		if !hasValue {
			i++
			if i >= len(args) {
				return fmt.Errorf("docker args: %s requires a value", flag)
			}
			value = args[i]
		}
		// The flag token is charset-checked above; the value token of a split flag never was,
		// and each per-kind validator only caught control characters in the fields it happened
		// to look at. A newline survives into anything that renders the spec a line at a time,
		// so it is refused once, here, for every kind rather than four times with one missing.
		if strings.ContainsAny(value, dockerControlChars) {
			return fmt.Errorf("docker args: %s: invalid value", flag)
		}
		var err error
		switch kind {
		case "publish":
			err = validateDockerPublish(value)
		case "volume":
			err = validateDockerVolume(value)
		case "env":
			err = validateDockerEnv(value)
		case "add-host":
			if value != "host.docker.internal:host-gateway" {
				err = fmt.Errorf("only the Portless mesh host-gateway entry is allowed")
			}
		}
		if err != nil {
			return fmt.Errorf("docker args: %s: %w", flag, err)
		}
	}
	return nil
}

func validateDockerPublish(value string) error {
	parts := strings.Split(value, ":")
	if len(parts) != 2 && len(parts) != 3 {
		return fmt.Errorf("publish must be hostPort:containerPort or 127.0.0.1:hostPort:containerPort")
	}
	if len(parts) == 3 && parts[0] != "127.0.0.1" {
		return fmt.Errorf("explicit publish address must be 127.0.0.1")
	}
	for _, raw := range parts[len(parts)-2:] {
		if err := validateDockerPort(raw); err != nil {
			return err
		}
	}
	return nil
}

// Docker takes the protocol off the LAST slash and parses what remains with
// strconv.ParseUint(_, 10, 16). Trimming a "/tcp" suffix and then a "/udp" suffix stripped both
// from "80/udp/tcp" and left a clean "80" — an argument Docker itself refuses, approved here.
// Exactly one suffix comes off, and what is left has to be decimal digits and nothing else.
func validateDockerPort(raw string) error {
	digits := raw
	if slash := strings.LastIndex(raw, "/"); slash != -1 {
		// Docker also speaks SCTP; these Nodes route TCP and UDP, so the allowlist stops there.
		if proto := raw[slash+1:]; proto != "tcp" && proto != "udp" {
			return fmt.Errorf("invalid port %q", raw)
		}
		digits = raw[:slash]
	}
	if !dockerPortDigits.MatchString(digits) {
		return fmt.Errorf("invalid port %q", raw)
	}
	port, err := strconv.Atoi(digits)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("invalid port %q", raw)
	}
	return nil
}

func validateDockerVolume(value string) error {
	if strings.Contains(strings.ToLower(value), "docker.sock") {
		return fmt.Errorf("container-runtime sockets are not mountable")
	}
	parts := strings.Split(value, ":")
	if len(parts) < 2 || len(parts) > 3 || !dockerVolumeName.MatchString(parts[0]) {
		return fmt.Errorf("only named-volume mounts are allowed")
	}
	if err := validateDockerVolumeTarget(parts[1]); err != nil {
		return err
	}
	if len(parts) == 3 && parts[2] != "ro" {
		return fmt.Errorf("only the read-only volume option is allowed")
	}
	return nil
}

// Judge the target by what it means, not by how it is spelled. `/var/lib/data/`, `//var/lib/data`
// and `/var/./lib/data` all name the directory Docker will mount into, so refusing them — which a
// bare `path.Clean(target) != target` did — rejects a working App for a cosmetic reason. `/.` names
// the container root, which is refused however it is written. A literal ".." segment is refused
// outright rather than only when it survives normalisation, so that a reader does not have to
// normalise in their head to know the answer.
func validateDockerVolumeTarget(target string) error {
	if !strings.HasPrefix(target, "/") {
		return fmt.Errorf("container mount target must be an absolute path")
	}
	named := false
	for _, segment := range strings.Split(target, "/") {
		if segment == ".." {
			return fmt.Errorf(`container mount target may not contain a ".." segment`)
		}
		if segment != "" && segment != "." {
			named = true
		}
	}
	if !named {
		return fmt.Errorf("the container root is not a mount target")
	}
	return nil
}

func validateDockerEnv(value string) error {
	key, _, ok := strings.Cut(value, "=")
	if !ok || !dockerEnvName.MatchString(key) {
		return fmt.Errorf("environment values must be KEY=value")
	}
	return nil
}
