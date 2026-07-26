function requireEnv(name: "CONVEX_URL" | "MACHINE_TOKEN") {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export const config = {
  convexUrl: requireEnv("CONVEX_URL"),
  machineToken: requireEnv("MACHINE_TOKEN"),
  heartbeatMs: 30_000,
};

try {
  new URL(config.convexUrl);
} catch {
  throw new Error("CONVEX_URL must be a valid URL");
}

if (!/^[0-9a-f]{32}$/i.test(config.machineToken)) {
  throw new Error("MACHINE_TOKEN must be the 32-character token from Runner Center");
}
