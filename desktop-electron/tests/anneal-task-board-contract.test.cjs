"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.join(__dirname, "..");
const surfacePath = path.join(desktopRoot, "src", "features", "AnnealTasksSurface.tsx");

test("Anneal task surface uses project-scoped real board operations without crossing ID domains", () => {
  const source = fs.readFileSync(surfacePath, "utf8");

  assert.match(source, /operation: "projects"/);
  assert.match(source, /operation: "listTasks"/);
  assert.match(source, /arguments: \{ projectId \}/);
  assert.match(source, /operation: "preview"/);
  assert.match(source, /moveTargets/);
  assert.match(source, /target\.via === "start"/);
  assert.match(source, /operation: target\.via === "start" \? "startTask" : "updateTask"/);
  assert.match(source, /operation: "agent_control"/);
  assert.match(source, /const annealBoardGeneration = useRef\(0\)/);
  assert.match(source, /const annealBoardRequest = useRef\(0\)/);
  assert.match(source, /setAnnealTasks\(\[\]\);\s*setAnnealTaskId\(""\);\s*setAnnealTaskDetails\(null\)/);
  assert.match(
    source,
    /generation !== annealBoardGeneration\.current\s*\|\| projectId !== annealProjectIdRef\.current\s*\|\| requestId !== annealBoardRequest\.current/,
  );
  assert.equal(
    source.match(/generation !== annealBoardGeneration\.current \|\| projectId !== annealProjectIdRef\.current/g)?.length,
    2,
  );

  assert.doesNotMatch(source, /anneal_preview/);
  assert.doesNotMatch(source, /taskOptions\(/);
  assert.doesNotMatch(source, /task_id:\s*annealTaskId/);
});
