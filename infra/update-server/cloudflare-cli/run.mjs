import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tooling = dirname(fileURLToPath(import.meta.url));

const root = dirname(tooling);

const settings = JSON.parse(
  readFileSync(join(tooling, "projects.json"), "utf8"),
);

const args = process.argv.slice(2);

function takeOption(name) {
  const index = args.indexOf(name);

  if (index < 0) return undefined;
  const value = args[index + 1];

  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  args.splice(index, 2);

  return value;
}

function run(command, argv, cwd) {
  const result = spawnSync(command, argv, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) throw result.error;

  if (result.status !== 0) process.exit(result.status ?? 1);
}

const target = takeOption("--target") ?? "app";

const project = settings[target];

if (!project)
  throw new Error(
    `Unknown target ${target}. Available: ${Object.keys(settings).join(", ")}`,
  );

const cwd = join(tooling, target);

const executable = join(cwd, "node_modules/cf/bin/cf");

const skipIndex = args.indexOf("--skip-prepare");

const skipPrepare = skipIndex >= 0;

if (skipPrepare) args.splice(skipIndex, 1);

let action = args.shift();

let selectedMode;

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--mode" || args[index] === "-m") {
    const mode = args[index + 1];

    if (!mode) throw new Error("The mode flag requires a value.");
    args[index + 1] = project.modeAliases?.[mode] ?? mode;
    selectedMode = args[index + 1];
  } else if (args[index].startsWith("--mode=")) {
    const mode = args[index].slice("--mode=".length);
    args[index] = `--mode=${project.modeAliases?.[mode] ?? mode}`;
    selectedMode = project.modeAliases?.[mode] ?? mode;
  }
}

if (!action || action === "help") {
  console.log(
    "Usage: node cloudflare-cli/run.mjs [--target app|mcp|build] <cf command> [arguments]",
  );
  console.log(
    "build, dev, deploy and dry-run prepare the existing application build first.",
  );
  console.log(
    "Use --skip-prepare to validate existing artifacts. Use --mode for named environments.",
  );
  console.log(
    "db:migrate <binding-or-name> requires --local or --remote and preserves the original local state.",
  );
  console.log(
    `Deployment owner: ${project.deploymentOwner}. See cloudflare-cli/README.md.`,
  );
  process.exit(0);
}

const building = ["build", "dev", "deploy", "dry-run"].includes(action);

if (building || action === "db:migrate") {
  if (args.includes("--env"))
    throw new Error("Use --mode to select a cf environment.");

  if (selectedMode && !project.modes.includes(selectedMode)) {
    throw new Error(
      `Unknown mode ${selectedMode}. Available: ${project.modes.join(", ") || "default only"}`,
    );
  }

  const hash = createHash("sha256")
    .update(readFileSync(join(root, project.source)))
    .digest("hex");

  if (hash !== project.sourceHash) {
    throw new Error(
      `${project.source} changed after migration. Reconcile ${target}/cloudflare.config.ts and update projects.json sourceHash before continuing.`,
    );
  }
}

if (
  action === "deploy" &&
  !args.includes("--dry-run") &&
  project.deploymentOwner !== "cf"
) {
  throw new Error(
    `Deployment is owned by ${project.deploymentOwner}. Use the existing release command; cf dry-run remains available.`,
  );
}

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!/^(?:\.env|\.dev\.vars)(?:\.|$)/.test(entry.name)) continue;
  const source = join(root, entry.name);
  const destination = join(cwd, entry.name);

  if (!entry.isFile() && !entry.isSymbolicLink()) continue;

  try {
    lstatSync(destination);
    continue;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  symlinkSync(relative(cwd, source), destination);
}

for (const [originalMode, nativeMode] of Object.entries(
  project.modeAliases ?? {},
)) {
  const source = join(root, `.dev.vars.${originalMode}`);
  const destination = join(cwd, `.dev.vars.${nativeMode}`);

  if (existsSync(source) && !existsSync(destination))
    symlinkSync(relative(cwd, source), destination);
}

if (!existsSync(executable)) {
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd);
}

if (building && !skipPrepare && project.prepare) {
  run(project.prepare[0], project.prepare.slice(1), root);
}

if (action === "dry-run") {
  action = "deploy";
  args.unshift("--dry-run");
}

if (action === "dev") {
  let persistTo = takeOption("--persist-to");
  const equalsIndex = args.findIndex((arg) => arg.startsWith("--persist-to="));

  if (equalsIndex >= 0)
    persistTo = args.splice(equalsIndex, 1)[0].slice("--persist-to=".length);
  const originalState = resolve(root, persistTo ?? project.persistTo);
  const localState = join(cwd, ".wrangler/state");
  mkdirSync(originalState, { recursive: true });
  mkdirSync(dirname(localState), { recursive: true });
  let current;

  try {
    current = lstatSync(localState);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (current) {
    if (current.isSymbolicLink()) {
      if (
        resolve(dirname(localState), readlinkSync(localState)) !== originalState
      )
        unlinkSync(localState);
    } else {
      // Preserve any state created before the compatibility link was installed.
      renameSync(localState, `${localState}.before-link-${Date.now()}`);
    }
  }

  if (!existsSync(localState))
    symlinkSync(
      relative(dirname(localState), originalState),
      localState,
      "junction",
    );
}

if (action === "db:migrate") {
  const selector = args.shift();
  const local = args.includes("--local");
  const remote = args.includes("--remote");

  if (local === remote)
    throw new Error("Choose exactly one of --local and --remote.");
  const mode = selectedMode;
  const databases = mode ? project.databases[mode] : project.databases.default;

  const database = databases?.find(
    (item) =>
      item.binding === selector ||
      item.name === selector ||
      item.id === selector,
  );

  if (!database)
    throw new Error(
      `No D1 database matches ${selector} in mode ${mode ?? "default"}.`,
    );
  const forwarded = args.filter((arg) => arg !== "--remote");

  if (
    local &&
    !forwarded.some(
      (arg) => arg === "--persist-to" || arg.startsWith("--persist-to="),
    )
  )
    forwarded.push("--persist-to", resolve(root, project.persistTo));

  if (local) {
    // cf beta 12 leaves its local resource runtime open after completing D1 commands.
    // Wrangler remains the compatibility backend until that CLI issue is fixed.
    const legacy = forwarded.filter(
      (arg) =>
        !["--mode", "-m"].includes(arg) &&
        arg !== selectedMode &&
        !arg.startsWith("--mode="),
    );

    const originalMode =
      Object.entries(project.modeAliases ?? {}).find(
        ([, value]) => value === mode,
      )?.[0] ?? mode;

    if (originalMode) legacy.push("--env", originalMode);
    run(
      process.execPath,
      [
        join(cwd, "node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "migrations",
        "apply",
        database.binding,
        "--config",
        resolve(root, project.source),
        ...legacy,
      ],
      root,
    );
  } else {
    run(
      process.execPath,
      [
        executable,
        "d1",
        "migrations",
        "apply",
        database.id,
        "--dir",
        resolve(root, database.directory),
        ...forwarded,
      ],
      cwd,
    );
  }
} else {
  run(process.execPath, [executable, action, ...args], cwd);

  if (action === "build" && project.copyBundleTo) {
    const destination = resolve(root, project.copyBundleTo);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(
      join(cwd, ".cloudflare/output/v0/workers/default/bundle/index.js"),
      destination,
    );
  }
}
