import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 5.9.2 fixed GHSA-9rgm-9g3h-6x36; 5.9.3 fixed GHSA-j22f-vq7h-c4qm, GHSA-hx4r-w6wj-j8fg,
// GHSA-mcm9-63f2-9j32, GHSA-wf3x-273g-mvxv, GHSA-x5rw-q4pp-hg5g and GHSA-4q55-j62x-fr9h.
// SvelteKit 3 requires devalue ^5.9.4 itself, so the override that pinned it is gone.
test("devalue is patched against GHSA-9rgm-9g3h-6x36 and the 5.9.3 advisories", async () => {
  const read = async (file) => JSON.parse(await readFile(new URL(file, import.meta.url), "utf8"));
  const kit = await read("../node_modules/@sveltejs/kit/package.json");
  const installed = await read("../node_modules/devalue/package.json");
  assert.equal(kit.dependencies.devalue, "^5.9.4");
  const [major, minor, patch] = installed.version.split(".").map(Number);
  assert.ok(major > 5 || (major === 5 && (minor > 9 || (minor === 9 && patch >= 4))), `devalue ${installed.version} is at least 5.9.4`);
});
