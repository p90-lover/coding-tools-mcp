const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const repoRoot = path.resolve(__dirname, "..", "..");

function uniqueRoot() {
  return path.join(
    repoRoot,
    "aiTemp",
    "no-delete-preload-test",
    `${process.platform}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
}

test("no-delete preload starts on supported Node and retains unlink targets", () => {
  const root = uniqueRoot();
  const sourceRoot = path.join(root, "source");
  const retainedRoot = path.join(
    repoRoot,
    "aiTemp",
    "Trash",
    "no-delete-preload-test",
    path.basename(root),
  );
  const target = path.join(sourceRoot, "original.txt");
  const original = "retained original bytes\n";

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(target, original, "utf8");

  const preload = path.join(
    repoRoot,
    "runtime-web",
    "scripts",
    "no-delete-preload.mjs",
  );
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      "-e",
      "require('node:fs').unlinkSync(process.argv[1])",
      target,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODING_TOOLS_RETENTION_ROOT: retainedRoot,
      },
      encoding: "utf8",
      timeout: 15_000,
    },
  );

  assert.equal(
    child.status,
    0,
    `preload child failed\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
  assert.equal(fs.existsSync(target), false, "source should be moved, not copied in place");

  const retained = fs.readdirSync(retainedRoot, { withFileTypes: true });
  assert.equal(retained.length, 1, "exactly one original should be retained");
  assert.equal(retained[0].isFile(), true);
  assert.equal(
    fs.readFileSync(path.join(retainedRoot, retained[0].name), "utf8"),
    original,
  );
});
