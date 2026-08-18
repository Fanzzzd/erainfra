// Reports the four Actions cache variables as a JavaScript action step sees
// them, in the same format `.github/probes/tiers.sh` writes for a `run:` step,
// so the two tiers can be put in one table and compared.
//
// The rendering rules are duplicated from tiers.sh rather than shared, because
// one is shell in a `run:` step and the other is Node in an action step and
// there is no third place both can read. `probe.test.sh` runs BOTH against the
// same environment and fails if they disagree, which is what keeps the
// duplication honest.

import { writeFileSync } from "node:fs";

const NAMES = [
  "ACTIONS_CACHE_URL",
  "ACTIONS_RESULTS_URL",
  "ACTIONS_CACHE_SERVICE_V2",
  "ACTIONS_RUNTIME_TOKEN",
];

const out = process.env.INPUT_OUT;
if (out === undefined || out.length === 0) {
  console.error("the `out` input is required: the snapshot file is the whole output");
  process.exit(2);
}

// ACTIONS_RUNTIME_TOKEN is a credential and this snapshot is printed into a job
// summary, so it is reported by presence and length and never by value.
function render(name, value) {
  if (value === undefined) return "unset";
  if (name === "ACTIONS_RUNTIME_TOKEN") return `present, ${Buffer.byteLength(value)} bytes`;
  return value.length === 0 ? "set-but-empty" : value;
}

const lines = NAMES.map((name) => `${name}\t${render(name, process.env[name])}`);
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
