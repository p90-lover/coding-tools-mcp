import { mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const tempRoot = join(root, "aiTemp", "verify");
const retainedRoot = join(root, "aiTemp", "Trash", "verify");
const noDeletePreload = join(root, "scripts", "no-delete-preload.mjs");
mkdirSync(tempRoot, { recursive: true });
const scratch = mkdtempSync(join(tempRoot, "run-"));
const runtimeBundle = join(scratch, "runtime");

async function run(args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, "--preload", noDeletePreload, ...args], {
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      TMPDIR: join(root, "aiTemp", "tmp"),
      TMP: join(root, "aiTemp", "tmp"),
      TEMP: join(root, "aiTemp", "tmp"),
      CODING_TOOLS_RETENTION_ROOT: join(root, "aiTemp", "Trash", "upstream-suite"),
    },
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Verification command failed (${exitCode}): bun ${args.join(" ")}`);
}

mkdirSync(join(root, "aiTemp", "tmp"), { recursive: true });
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
