"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(
  path.resolve(__dirname, "../src/features/OriginalUiSurface.tsx"),
  "utf8",
);

test("CPA recovery rejects stale persisted sections before reopening the original UI", () => {
  assert.match(
    source,
    /function selectedFrom\(tool: OriginalUiSnapshot \| null, preferredSection = ""\): string/,
  );
  assert.match(source, /const sections = tool\?\.sections \?\? \[\]/);
  assert.match(
    source,
    /if \(preferredSection && sections\.includes\(preferredSection\)\) return preferredSection/,
  );
  assert.match(
    source,
    /if \(persistedSection && sections\.includes\(persistedSection\)\) return persistedSection/,
  );
  assert.match(source, /setSelectedSection\(\(value\) => selectedFrom\(current, value\)\)/);
  assert.match(source, /setSelectedSection\(selectedFrom\(current\)\)/);
  assert.match(source, /setSelectedSection\(\(value\) => selectedFrom\(tool, value\)\)/);
  assert.doesNotMatch(source, /selectedSection \|\| selectedFrom\(tool\)/);
  assert.match(source, /openSection\(selectedFrom\(tool, selectedSection\)\)/);
});
