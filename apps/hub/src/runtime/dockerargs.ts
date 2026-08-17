const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL = /[\0\n\r]/;
// Docker parses a port with strconv.ParseUint(raw, 10, 16): decimal digits, nothing else.
const PORT_DIGITS = /^[0-9]+$/;

// Compatibility parser for the existing Docker-args API. Only these inert deployment shapes are
// accepted; every unknown flag fails closed. The Go node repeats the same policy at the actual host
// trust boundary, so a bypass or mixed caller cannot turn this validation into remote root access.
//
// "Repeats the same policy" is asserted, not assumed: testdata/dockerargs-cases.json is read as a
// table test by test/dockerargs.test.ts here and by dockerargs_conformance_test.go there. Any rule
// changed in this file has to be changed in both, or the fixture goes red.
export function validateDockerArgs(args: readonly string[]): string | null {
  if (args.length > 64) return "docker args: at most 64 tokens";
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    // Bytes, not JavaScript string units: the cap bounds what is handed to `docker run`, and
    // ARG_MAX, a unit file and a log line all count bytes. Counting UTF-16 units here made the
    // same 512 mean two different things on the two paths.
    if (!flag || Buffer.byteLength(flag, "utf8") > 512 || CONTROL.test(flag))
      return "docker args: invalid token";
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
    // The flag token is charset-checked above; the value token of a split flag never was, and
    // each per-kind validator only caught control characters in the fields it happened to look
    // at. A newline survives into anything that renders the spec a line at a time, so it is
    // refused once, here, for every kind rather than four times with one of them missing.
    if (CONTROL.test(value)) return `docker args: ${flag}: invalid value`;
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
    const error = validatePort(raw);
    if (error) return error;
  }
  return null;
}

// Docker takes the protocol off the LAST slash and parses what remains with
// strconv.ParseUint(_, 10, 16). A port is therefore a token and not a numeric quantity: parsing
// it as one accepts `0x50`, `1e3`, `80.0` and ` 80 ` — specs Docker refuses, approved here while
// believing a port number that is not the one being handed over.
function validatePort(raw: string): string | null {
  let digits = raw;
  const slash = raw.lastIndexOf("/");
  if (slash !== -1) {
    const proto = raw.slice(slash + 1);
    // Docker also speaks SCTP; these Nodes route TCP and UDP, so the allowlist stops there.
    if (proto !== "tcp" && proto !== "udp") return `invalid port "${raw}"`;
    digits = raw.slice(0, slash);
  }
  if (!PORT_DIGITS.test(digits)) return `invalid port "${raw}"`;
  const port = Number(digits);
  if (port < 1 || port > 65535) return `invalid port "${raw}"`;
  return null;
}

function validateVolume(value: string): string | null {
  if (value.toLowerCase().includes("docker.sock"))
    return "container-runtime sockets are not mountable";
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3 || !VOLUME_NAME.test(parts[0]))
    return "only named-volume mounts are allowed";
  const error = validateVolumeTarget(parts[1]);
  if (error) return error;
  if (parts.length === 3 && parts[2] !== "ro") return "only the read-only volume option is allowed";
  return null;
}

// Judge the target by what it means, not by how it is spelled. `/var/lib/data/`, `//var/lib/data`
// and `/var/./lib/data` all name the directory Docker will mount into, so refusing them rejects a
// working App for a cosmetic reason; `/.` names the container root, which is refused however it is
// written. A literal `..` segment is refused outright rather than only when it survives
// normalisation, so that a reader does not have to normalise in their head to know the answer.
function validateVolumeTarget(target: string): string | null {
  if (!target.startsWith("/")) return "container mount target must be an absolute path";
  const segments = target.split("/");
  if (segments.includes("..")) return 'container mount target may not contain a ".." segment';
  if (segments.every((segment) => segment === "" || segment === "."))
    return "the container root is not a mount target";
  return null;
}

function validateEnv(value: string): string | null {
  const equal = value.indexOf("=");
  if (equal < 1 || !ENV_NAME.test(value.slice(0, equal)))
    return "environment values must be KEY=value";
  return null;
}
