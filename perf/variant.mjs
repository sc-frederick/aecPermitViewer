// Prepares benchmark variants for perf/permits.bench.ts. strobe runs both commands in the variant's folder.
//
//   node perf/variant.mjs build   once per variant: install if needed, build, and seed the fixture database with this
//                                 variant's own store code (perf/seed-fixture.ts), so its schema always matches.
//   node perf/variant.mjs seed    before each launch: copy that database into PERMIT_MONITOR_DATA_DIR.
//
// Seeding writes thousands of transactions and is bound by fsync, so it happens once; a launch only copies the file.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

// Under node_modules/.cache, which packaging leaves out (forge.config.cjs).
const cache = path.join("node_modules", ".cache", "permit-monitor-perf");

const fixture = path.join(cache, "fixture");

// The layout dataRoot() and databasePath() in src/main/paths.ts give an isolated run.
const database = path.join("PermitMonitorData", "data", "permits.sqlite");

function requireIsolation() {
  // Old git variants must receive strobe.json's shared isolation code before they build or launch. Refuse an
  // unsupported source tree rather than silently letting Electron fall back to the user's normal profile.
  const required = [
    ["src/main/paths.ts", 'if (isolated) return path.join(isolated, "PermitMonitorData");'],
    ["src/main/index.ts", 'app.setPath("userData", profile);'],
    ["src/main/index.ts", "isolated ? null : loadShareService(syncConfigPath())"],
    ["src/main/electron-key-store.ts", "app.isPackaged || isolated ? null"],
    ["src/main/electron-key-store.ts", "!isolated &&"],
  ];

  for (const [file, support] of required) {
    if (!readFileSync(file, "utf8").includes(support))
      throw new Error(`Benchmark isolation is missing from ${file}; check strobe.json's harness.`);
  }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env, shell: process.platform === "win32" });

  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function build() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";

  // A git variant is a fresh worktree without dependencies. A checkout that has them keeps them: `npm ci` would delete
  // the running strobe, and `npm install` can rewrite the lockfile.
  if (!existsSync(path.join("node_modules", ".package-lock.json"))) run(npm, ["ci", "--allow-git=all"]);
  run(npm, ["run", "build"]);

  const { build: bundle } = await import("esbuild");
  const seeder = path.join(cache, "seed-fixture.cjs");
  await bundle({
    entryPoints: ["perf/seed-fixture.ts"],
    outfile: seeder,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    logLevel: "warning",
  });
  rmSync(fixture, { recursive: true, force: true });
  run(process.execPath, [seeder], { ...process.env, PERMIT_MONITOR_DATA_DIR: fixture });
}

function seed() {
  const directory = process.env.PERMIT_MONITOR_DATA_DIR?.trim();

  if (!directory) throw new Error("Set PERMIT_MONITOR_DATA_DIR to the launch's private folder.");
  const target = path.join(path.resolve(directory), database);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(fixture, database), target);
}

const command = process.argv[2];

requireIsolation();

if (command === "build") await build();
else if (command === "seed") seed();
else throw new Error("Usage: node perf/variant.mjs build|seed");
