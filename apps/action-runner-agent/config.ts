function requireEnv(name: "CONVEX_URL" | "MACHINE_TOKEN") {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * The job cache endpoint this Worker offers its jobs, or nothing at all.
 *
 * OFF by default and that is the point: a fleet with no cache endpoint
 * configured composes exactly the environment it composed before, and the two
 * variables below never appear on a `docker run` command line.
 *
 * The names a container receives are `ACTIONS_CACHE_URL` and
 * `ACTIONS_CACHE_SERVICE_V2`, because those are what the cache clients read;
 * the names an OPERATOR sets are `ERAINFRA_CACHE_*`, because a Worker's
 * configuration is EraInfra's and must not be confusable with the runner's own
 * job-message variables.
 *
 * Two variables rather than one, and independent, because they answer different
 * questions and carry different risk. The flag alone is a free measurement: it
 * changes which generation a client picks and GitHub serves both, so an
 * operator can find out whether an EraInfra-set value survives at all without
 * pointing a single byte of cache traffic anywhere new. The URL is the one that
 * moves traffic.
 *
 * `ACTIONS_RESULTS_URL` and `ACTIONS_RUNTIME_TOKEN` are deliberately absent and
 * must stay absent. Probe run 32109974600 measured the artifact service living
 * at the same `ACTIONS_RESULTS_URL` behind the same `ACTIONS_RUNTIME_TOKEN`, so
 * repointing either to carry cache traffic takes `actions/upload-artifact` away
 * from every job on this Worker. That is not a trade this seam is allowed to
 * make silently.
 */
function cacheEnvironment() {
  const url = process.env.ERAINFRA_CACHE_URL?.trim();
  const serviceV2 = process.env.ERAINFRA_CACHE_SERVICE_V2?.trim();

  if (url !== undefined && url.length > 0) {
    // Refused at startup rather than at the first Attempt. An agent that boots
    // with a malformed endpoint would hand every job a cache it cannot reach,
    // and the symptom -- slow jobs, no error -- is the one nobody traces back
    // to a typo in a unit file.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("ERAINFRA_CACHE_URL must be an absolute http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("ERAINFRA_CACHE_URL must be an absolute http(s) URL");
    }
  }

  if (serviceV2 !== undefined && serviceV2.length > 0 && !["true", "false"].includes(serviceV2)) {
    throw new Error('ERAINFRA_CACHE_SERVICE_V2 must be exactly "true" or "false"');
  }

  return {
    ...(url !== undefined && url.length > 0 ? { url } : {}),
    ...(serviceV2 !== undefined && serviceV2.length > 0 ? { serviceV2 } : {}),
  };
}

export const config = {
  convexUrl: requireEnv("CONVEX_URL"),
  machineToken: requireEnv("MACHINE_TOKEN"),
  heartbeatMs: 30_000,
  cache: cacheEnvironment(),
};

if (!URL.canParse(config.convexUrl)) {
  throw new Error("CONVEX_URL must be a valid URL");
}

if (!/^[0-9a-f]{32}$/i.test(config.machineToken)) {
  throw new Error("MACHINE_TOKEN must be the 32-character token from EraInfra");
}
