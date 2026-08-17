package agent

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
)

// Docker args remain a compatibility surface for existing safe deployments, but they are parsed
// here at the node trust boundary and rendered only from a small allowlist. Unknown flags fail
// closed; in particular there is no syntax that can request host namespaces, devices, elevated
// capabilities, security-profile changes, bind mounts, or host sockets.
var (
	dockerVolumeName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
	dockerEnvName    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
)

func validateDockerArgs(args []string) error {
	if len(args) > 64 {
		return fmt.Errorf("docker args: at most 64 tokens")
	}
	for i := 0; i < len(args); i++ {
		flag := args[i]
		if flag == "" || len(flag) > 512 || strings.ContainsAny(flag, "\x00\n\r") {
			return fmt.Errorf("docker args: invalid token")
		}
		value := ""
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
					break
				}
			}
			if kind == "" {
				return fmt.Errorf("docker args: flag %q is not allowed", flag)
			}
		}
		if value == "" {
			i++
			if i >= len(args) {
				return fmt.Errorf("docker args: %s requires a value", flag)
			}
			value = args[i]
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
		portText := strings.TrimSuffix(strings.TrimSuffix(raw, "/tcp"), "/udp")
		port, err := strconv.Atoi(portText)
		if err != nil || port < 1 || port > 65535 {
			return fmt.Errorf("invalid port %q", raw)
		}
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
	target := parts[1]
	if !strings.HasPrefix(target, "/") || target == "/" || path.Clean(target) != target || strings.ContainsAny(target, "\x00\n\r") {
		return fmt.Errorf("invalid container mount target")
	}
	if len(parts) == 3 && parts[2] != "ro" {
		return fmt.Errorf("only the read-only volume option is allowed")
	}
	return nil
}

func validateDockerEnv(value string) error {
	key, _, ok := strings.Cut(value, "=")
	if !ok || !dockerEnvName.MatchString(key) || strings.ContainsAny(value, "\x00\n\r") {
		return fmt.Errorf("environment values must be KEY=value")
	}
	return nil
}
