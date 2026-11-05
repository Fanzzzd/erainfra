// Temporary: logs every fs.promises.writeFile under .source/ and the moment
// the process exits, with the sizes the .source files have at that moment.
import fs from "node:fs";
import fsp from "node:fs/promises";

const t0 = performance.now();
const ms = () => (performance.now() - t0).toFixed(1).padStart(7);
const log = (m) => fs.writeSync(2, `[trace ${process.pid} ${ms()}ms] ${m}\n`);

const orig = fsp.writeFile;
fsp.writeFile = async function (file, data, ...rest) {
  const p = String(file);
  if (!p.includes(".source")) return orig.call(this, file, data, ...rest);
  log(`writeFile start ${p} (${Buffer.byteLength(String(data))} bytes)`);
  try {
    return await orig.call(this, file, data, ...rest);
  } finally {
    log(`writeFile done  ${p}`);
  }
};

const sizes = () => {
  try {
    return fs
      .readdirSync(".source")
      .map((f) => `${f}=${fs.statSync(".source/" + f).size}`)
      .join(" ");
  } catch (e) {
    return String(e);
  }
};

const origExit = process.exit;
process.exit = function (code) {
  log(`process.exit(${code}) called; .source: ${sizes()}`);
  return origExit.call(this, code);
};
process.on("exit", () => log(`exit event; .source: ${sizes()}`));
log(`loaded in ${process.argv.slice(1).join(" ")}`);
