// Times a synchronous load of many small CommonJS modules, the shape of a
// test that requires a bundler's whole configuration at once.
//
//   node modload.cjs pick <dir> <target> <list>   choose packages, write <list>
//   node modload.cjs load <dir> <list>            require <list>, print timing
//
// <dir> is a directory that holds a pnpm node_modules. `pick` requires the
// hoisted packages in name order until the module cache holds <target>
// modules, so every later `load` reads the same files. `load` prints one line:
// `modload ms=<require time> cpu=<ms> majflt=... modules=<count>`. `cpu` and
// the fault and context-switch counts cover the whole process, startup too.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const [mode, dir, a, b] = process.argv.slice(2);
const hoisted = path.join(path.resolve(dir), "node_modules", ".pnpm", "node_modules");

// Packages that start work or print on require; loading them measures
// something other than module resolution and reads.
const skip = new Set(["corepack", "npm", "pnpm", "turbo", "oxlint", "oxfmt"]);

function packages() {
  const names = [];
  for (const entry of fs.readdirSync(hoisted).toSorted()) {
    if (entry.startsWith("@")) {
      for (const sub of fs.readdirSync(path.join(hoisted, entry)).toSorted()) {
        names.push(`${entry}/${sub}`);
      }
    } else if (!entry.startsWith(".")) {
      names.push(entry);
    }
  }
  return names.filter((name) => !skip.has(name) && !name.startsWith("@types/"));
}

function count() {
  return Object.keys(require.cache).length;
}

if (mode === "pick") {
  const target = Number(a);
  const chosen = [];
  for (const name of packages()) {
    if (count() >= target) break;
    const before = count();
    try {
      require(path.join(hoisted, name));
    } catch {
      continue;
    }
    if (count() > before) chosen.push(name);
  }
  fs.writeFileSync(b, `${chosen.join("\n")}\n`);
  console.log(`modload picked=${chosen.length} modules=${count()}`);
} else if (mode === "load") {
  const names = fs.readFileSync(a, "utf8").split("\n").filter(Boolean);
  const start = process.hrtime.bigint();
  for (const name of names) {
    try {
      require(path.join(hoisted, name));
    } catch {
      // A package that loaded during `pick` and fails now still counts its
      // partial reads; the module count shows the difference.
    }
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const use = process.resourceUsage();
  const cpu = (use.userCPUTime + use.systemCPUTime) / 1000;
  console.log(
    `modload ms=${ms.toFixed(0)} cpu=${cpu.toFixed(0)} majflt=${use.majorPageFault} ` +
      `inblock=${use.fsRead} vcsw=${use.voluntaryContextSwitches} modules=${count()}`,
  );
} else {
  console.error("usage: modload.cjs pick <dir> <target> <list> | load <dir> <list>");
  process.exit(2);
}
// Some packages keep handles open; the measurement is done.
process.exit(0);
