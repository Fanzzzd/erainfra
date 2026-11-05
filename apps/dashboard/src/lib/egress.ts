type ProfileEgress = {
  mode: "public" | "audit" | "allowlist";
  presets: string[];
  domains: string[];
  cidrs: string[];
};

function listed(egress: ProfileEgress) {
  const parts = [
    ...egress.presets.map((preset) => `${preset} preset`),
    egress.domains.length > 0
      ? `${egress.domains.length} domain${egress.domains.length === 1 ? "" : "s"}`
      : undefined,
    egress.cidrs.length > 0
      ? `${egress.cidrs.length} CIDR${egress.cidrs.length === 1 ? "" : "s"}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" + ");
}

/** One line for the Profile table: the mode and what its list holds. */
export function describeProfileEgress(egress: ProfileEgress) {
  if (egress.mode === "public") return "public egress";
  const list = listed(egress);
  if (egress.mode === "audit") return list === "" ? "audit egress" : `audit egress · list: ${list}`;
  return `allowlist egress · ${list}`;
}

/** The full list, for the hover title. */
export function egressTooltip(egress: ProfileEgress) {
  if (egress.mode === "public") {
    return "Guests reach the public internet; the host, private ranges and other guests are dropped.";
  }
  const entries = [
    ...egress.presets.map((preset) => `preset:${preset}`),
    ...egress.domains,
    ...egress.cidrs,
  ];
  const lead =
    egress.mode === "audit"
      ? "Public egress, and the Worker records every DNS name and new flow per Attempt."
      : "Default deny: guests reach only these destinations.";
  return entries.length === 0 ? lead : `${lead}\n${entries.join("\n")}`;
}
