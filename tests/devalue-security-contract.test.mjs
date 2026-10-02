import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 5.9.2 fixed GHSA-9rgm-9g3h-6x36; 5.9.3 fixed GHSA-j22f-vq7h-c4qm, GHSA-hx4r-w6wj-j8fg,
// GHSA-mcm9-63f2-9j32, GHSA-wf3x-273g-mvxv, GHSA-x5rw-q4pp-hg5g and GHSA-4q55-j62x-fr9h.
test("devalue override is patched against GHSA-9rgm-9g3h-6x36 and the 5.9.3 advisories", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const installed = JSON.parse(
    await readFile(new URL("../node_modules/devalue/package.json", import.meta.url), "utf8"),
  );
  assert.equal(root.overrides.devalue, "5.9.4");
  assert.equal(installed.version, "5.9.4");
});
