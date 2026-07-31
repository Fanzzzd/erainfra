import { renderInstallScript } from "../convex/installScript.ts";

process.stdout.write(renderInstallScript(process.argv[2] ?? "https://example.convex.site"));
