import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("devalue override is patched against GHSA-9rgm-9g3h-6x36", async () => {
  const root = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const installed = JSON.parse(
    await readFile(new URL("../node_modules/devalue/package.json", import.meta.url), "utf8"),
  );
  assert.equal(root.overrides.devalue, "5.9.2");
  assert.equal(installed.version, "5.9.2");
});
