// Prints the installer this deployment would serve, so it can be read, diffed, or piped into a
// linter without deploying a backend. `win` prints the PowerShell body /install.ps1 serves; with no
// arguments, or with any other first argument, it prints the bash body /install serves.
//
//   pnpm --filter @erainfra/backend print-install-script [https://site] > out.sh
//   pnpm --filter @erainfra/backend print-install-script win [https://site] > out.ps1
import { AGENT_RELEASE } from "../convex/agentRelease.ts";
import { renderInstallScript } from "../convex/installScript.ts";
import { renderWindowsInstallScript } from "../convex/installScriptWin.ts";

const DEFAULT_SITE_URL = "https://example.convex.site";
const wantsWindows = process.argv[2] === "win";
const siteUrl = (wantsWindows ? process.argv[3] : process.argv[2]) ?? DEFAULT_SITE_URL;

process.stdout.write(
  wantsWindows
    ? renderWindowsInstallScript(siteUrl, AGENT_RELEASE)
    : renderInstallScript(siteUrl, AGENT_RELEASE),
);
