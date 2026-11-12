import { readFileSync } from "node:fs";

// The resolv.conf options every job gets, shared with the Firecracker guest
// (apps/runtime/cmd/runner-center-guest). The provisioner must pass exactly
// these, in this order, as --dns-option flags.
export const RESOLVER_OPTIONS: readonly string[] = (
  JSON.parse(
    readFileSync(new URL("../../../../testdata/resolver-options.json", import.meta.url), "utf8"),
  ) as { options: string[] }
).options;
