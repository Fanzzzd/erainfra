const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Compatibility parser for the existing Docker-args API. Only these inert deployment shapes are
// accepted; every unknown flag fails closed. The Go node repeats the same policy at the actual host
// trust boundary, so a bypass or mixed caller cannot turn this validation into remote root access.
export function validateDockerArgs(args: readonly string[]): string | null {
  if (args.length > 64) return "docker args: at most 64 tokens";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag || flag.length > 512 || /[\0\n\r]/.test(flag)) return "docker args: invalid token";
    let kind: "publish" | "volume" | "env" | "add-host" | undefined;
    let value: string | undefined;
    const combined: Array<[string, typeof kind]> = [
      ["-p=", "publish"],
      ["--publish=", "publish"],
      ["-v=", "volume"],
      ["--volume=", "volume"],
      ["-e=", "env"],
      ["--env=", "env"],
      ["--add-host=", "add-host"],
    ];
    if (flag === "-p" || flag === "--publish") kind = "publish";
    else if (flag === "-v" || flag === "--volume") kind = "volume";
    else if (flag === "-e" || flag === "--env") kind = "env";
    else if (flag === "--add-host") kind = "add-host";
    else {
      const found = combined.find(([prefix]) => flag.startsWith(prefix));
      if (!found) return `docker args: flag "${flag}" is not allowed`;
      kind = found[1];
      value = flag.slice(found[0].length);
    }
    // An `=`-joined flag carries its value even when that value is empty, so only an absent
    // value consumes the next token: treating `--env=` as "no value yet" would validate the
    // following token in a position Docker never reads it from.
    if (value === undefined) {
      value = args[++i];
      if (value === undefined) return `docker args: ${flag} requires a value`;
    }
    const error =
      kind === "publish"
        ? validatePublish(value)
        : kind === "volume"
          ? validateVolume(value)
          : kind === "env"
            ? validateEnv(value)
            : value === "host.docker.internal:host-gateway"
              ? null
              : "only the Portless mesh host-gateway entry is allowed";
    if (error) return `docker args: ${flag}: ${error}`;
  }
  return null;
}

function validatePublish(value: string): string | null {
  const parts = value.split(":");
  if (parts.length !== 2 && parts.length !== 3)
    return "publish must be hostPort:containerPort or 127.0.0.1:hostPort:containerPort";
  if (parts.length === 3 && parts[0] !== "127.0.0.1")
    return "explicit publish address must be 127.0.0.1";
  for (const raw of parts.slice(-2)) {
    const port = Number(raw.replace(/\/(tcp|udp)$/, ""));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `invalid port "${raw}"`;
  }
  return null;
}

function validateVolume(value: string): string | null {
  if (value.toLowerCase().includes("docker.sock"))
    return "container-runtime sockets are not mountable";
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3 || !VOLUME_NAME.test(parts[0]))
    return "only named-volume mounts are allowed";
  const target = parts[1];
  if (
    !target.startsWith("/") ||
    target === "/" ||
    target.includes("/../") ||
    target.endsWith("/..") ||
    /[\0\n\r]/.test(target)
  )
    return "invalid container mount target";
  if (parts.length === 3 && parts[2] !== "ro") return "only the read-only volume option is allowed";
  return null;
}

function validateEnv(value: string): string | null {
  const equal = value.indexOf("=");
  if (equal < 1 || !ENV_NAME.test(value.slice(0, equal)) || /[\0\n\r]/.test(value))
    return "environment values must be KEY=value";
  return null;
}
