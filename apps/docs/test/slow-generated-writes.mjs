// Preload for generated-files.test.mjs. fs.writeFile truncates a file and
// then writes it; this keeps every write under .source/ in the truncated
// state for SLOW_WRITE_MS, the way a busy CI machine sometimes does for a
// few milliseconds. A process that exits without awaiting its writes then
// leaves empty files behind on every run instead of on some runs.
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const delayMs = Number(process.env.SLOW_WRITE_MS ?? 3000);
const writeFile = fsp.writeFile;

fsp.writeFile = async function slowWriteFile(file, data, ...rest) {
  if (!String(file).includes(".source")) return writeFile.call(this, file, data, ...rest);
  await writeFile.call(this, file, "");
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  return writeFile.call(this, file, data, ...rest);
};
// Named imports (`import { writeFile } from "node:fs/promises"`) see the
// patch too.
syncBuiltinESMExports();
