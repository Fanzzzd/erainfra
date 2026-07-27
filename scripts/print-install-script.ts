import { renderInstallScript } from "../convex/installScript";

process.stdout.write(
  renderInstallScript(process.argv[2] ?? "https://example.convex.site"),
);
