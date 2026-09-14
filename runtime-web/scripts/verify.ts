import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { basename, join, parse, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const tempRoot = join(root, "aiTemp", "verify");
const retainedRoot = join(root, "aiTemp", "Trash", "verify");
const noDeletePreload = join(root, "scripts", "no-delete-preload.mjs");
const shortTempRoot = resolve(
  process.env.CODING_TOOLS_SHORT_TMP?.trim() || join(root, "aiTemp", "tmp"),
);
const shortTempParts = shortTempRoot.slice(parse(shortTempRoot).root.length).split(sep);
if (!shortTempParts.includes("aiTemp")) {
  throw new Error(`Verification temporary path must stay under aiTemp: ${shortTempRoot}`);
}
mkdirSync(tempRoot, { recursive: true });
mkdirSync(shortTempRoot, { recursive: true });
const scratch = mkdtempSync(join(tempRoot, "run-"));
const runtimeBundle = join(scratch, "runtime");

function bunCommand(args: string[]): string[] {
  if (args[0] === "run") {
    return [process.execPath, "run", "--preload", noDeletePreload, ...args.slice(1)];
  }
  return [process.execPath, "--preload", noDeletePreload, ...args];
}

async function run(args: string[]): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: shortTempRoot,
    TMP: shortTempRoot,
    TEMP: shortTempRoot,
    CODING_TOOLS_RETENTION_ROOT: join(root, "aiTemp", "Trash", "upstream-suite"),
  };
  // The parent workflow may use NODE_OPTIONS to protect its own scratch work.
  // Each child receives one explicit Bun preload in the correct `bun run`
  // position so the module is not imported twice and no script name is lost.
  delete environment.NODE_OPTIONS;
  const child = Bun.spawn(bunCommand(args), {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: environment,
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

try {
  await run(["run", "check-version"]);
  await run(["run", "audit"]);
  await run(["run", "launcher:audit"]);
  await run(["run", "typecheck"]);
  await run(["run", "test"]);
  await run(["run", "launcher:typecheck"]);
  await run(["run", "launcher:test"]);
  await run(["run", "launcher:build"]);
  await run(["run", "scripts/build-runtime-bundle.ts", runtimeBundle]);
  await run([
    "run",
    "scripts/generate-third-party-notices.ts",
    join(scratch, "THIRD_PARTY_NOTICES.txt"),
    "--include-launcher",
  ]);
  await run(["run", "scripts/smoke-release.ts", runtimeBundle]);
} finally {
  mkdirSync(retainedRoot, { recursive: true });
  renameSync(scratch, join(retainedRoot, basename(scratch)));
}
