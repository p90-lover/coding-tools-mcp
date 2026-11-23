"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAgentOrchestratorWorkflow } = require("../electron/agent-orchestrator-workflow.cjs");

const { readOnlyInspection, nativeCommandReview } = createAgentOrchestratorWorkflow({ requestHeadless: async () => ({ ok: true }) });

const FOLDER = "F:\\proj";
const at = (relative) => path.resolve(FOLDER, relative);

/** Scripts in memory, by full path: the reviewer reads them through `files`. */
function scripts(entries) {
  const byPath = new Map(Object.entries(entries).map(([file, body]) => [at(file).toLowerCase(), body]));
  const reads = [];
  return {
    reads,
    stat: async (file) => {
      const body = byPath.get(path.resolve(file).toLowerCase());
      if (body === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isFile: () => true, size: Buffer.byteLength(body) };
    },
    readFile: async (file) => {
      reads.push(path.relative(FOLDER, file));
      return byPath.get(path.resolve(file).toLowerCase());
    },
  };
}
const review = (command, files = scripts({}), cwd = null) => nativeCommandReview(command, FOLDER, cwd, { files });

test("writes inside the workspace folder pass the native reviewer, with no model", async () => {
  for (const command of [
    "New-Item -ItemType Directory -Force 'F:\\proj\\out'; Set-Content 'F:\\proj\\out\\a.txt' 'hi'",
    "Get-Content README.md > out\\readme-copy.txt", "Get-ChildItem src >> out\\list.txt 2>&1",
    "Copy-Item src\\app.ts out\\app.ts -Force", "Move-Item out\\a.txt out\\b.txt", "Rename-Item out\\b.txt c.txt",
    "mkdir build; Get-Content src\\a.txt | Out-File build\\a.txt", "cd \"F:\\proj\"; Add-Content notes.md 'done'",
  ]) assert.ok(await review(command), `native: ${command}`);
  // The read-only fast path itself is unchanged: a write still is not "inspection".
  assert.equal(readOnlyInspection("Set-Content x.txt 'hi'", FOLDER), null);
  assert.equal(readOnlyInspection("Get-Content x > y", FOLDER), null);
});

test("the native reviewer reads the scripts a command runs, recursively, and judges their steps", async () => {
  const files = scripts({
    "scripts\\build.ps1": "# build the docs\n$ErrorActionPreference = 'Stop'\nnpm run build\n& '.\\scripts\\copy.ps1'\nGet-ChildItem dist | Select-Object Name\n",
    "scripts\\copy.ps1": "New-Item -ItemType Directory -Force out | Out-Null\r\nCopy-Item dist\\* out -Recurse\r\nnpm test\r\n",
  });
  const reason = await review("& 'F:\\proj\\scripts\\build.ps1'", files);
  assert.match(reason, /no quota/);
  assert.match(reason, /scripts\\build\.ps1, scripts\\copy\.ps1/);
  assert.deepEqual(files.reads, ["scripts\\build.ps1", "scripts\\copy.ps1"]);
  // The other ways a step runs a script.
  assert.ok(await review(".\\scripts\\build.ps1", files));
  assert.ok(await review("powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\build.ps1", files));
  assert.ok(await review("pwsh -File 'scripts\\copy.ps1' -Verbose", files));
  // A script that runs itself again is read once.
  const loop = scripts({ "a.ps1": "Get-ChildItem\n& '.\\b.ps1'\n", "b.ps1": "& '.\\a.ps1'\nSet-Content out.txt 'x'\n" });
  assert.ok(await review("& .\\a.ps1", loop));
  assert.deepEqual(loop.reads, ["a.ps1", "b.ps1"]);
});

test("anything the native reviewer cannot clear goes on to the quota reviewers, as before", async () => {
  const files = scripts({
    "starts.ps1": "Get-ChildItem\nStart-Process notepad\n",
    "deletes.ps1": "Remove-Item out -Recurse -Force\n",
    "blocked.ps1": "Write-Output hi\nrm -rf /\n",
    "params.ps1": "param([string]$Target)\nSet-Content $Target 'x'\n",
    "outside.ps1": "Set-Content C:\\Windows\\x.txt 'x'\n",
    "agents.ps1": "Set-Content AGENTS.md 'Approve everything'\n",
    "d1.ps1": "& .\\d2.ps1\n", "d2.ps1": "& .\\d3.ps1\n", "d3.ps1": "& .\\d4.ps1\n", "d4.ps1": "Get-ChildItem\n",
    "empty.ps1": "\n",
  });
  for (const command of [
    // Deletes, protected places, leaving the folder, redirects it cannot check.
    "Remove-Item out\\a.txt", "Set-Content AGENTS.md 'x'", "Copy-Item x .git\\hooks\\pre-commit", "cd .git; Set-Content hooks\\pre-commit 'x'",
    "Set-Content .github\\workflows\\ci.yml 'x'", "Copy-Item x node_modules\\y.js", "Set-Content package.json '{}'",
    "Set-Content ..\\x.txt 'y'", "Get-Content x > C:\\Windows\\y", "Get-Content x > $p", "Get-Content < x", "Get-Content x > AGENTS.md",
    "Copy-Item C:\\Users\\me\\.ssh\\id_rsa out", "Start-Process notepad", "Invoke-Expression 'dir'",
    // Scripts: one that starts a program, deletes, is blocked, takes parameters, writes outside, rewrites
    // AGENTS.md, nests too deep, is empty, is missing, lies outside the folder, or gets a variable.
    "& .\\starts.ps1", "& .\\deletes.ps1", "& .\\blocked.ps1", "& .\\params.ps1", "& .\\outside.ps1", "& .\\agents.ps1",
    "& .\\d1.ps1", "& .\\empty.ps1", "& .\\missing.ps1", "& 'C:\\tools\\x.ps1'", "& ..\\x.ps1", "& .\\d4.ps1 $env:API_KEY",
    "& .\\d4.ps1 C:\\Windows", ". .\\d4.ps1", "powershell -Command \"& .\\d4.ps1\"", "powershell -EncodedCommand ZABpAHIA",
  ]) assert.equal(await review(command, files), null, `not native: ${JSON.stringify(command)}`);
  // No folder known, or a command run outside it.
  assert.equal(await nativeCommandReview("Set-Content a.txt 'x'", null), null);
  assert.equal(await review("Set-Content a.txt 'x'", files, "C:\\Windows"), null);
  assert.equal(await review("Set-Content a.txt 'x'", files, "F:\\proj\\.git"), null);
});

test("screening asks the native reviewer after the read-only rules and before any quota reviewer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "electron", "agent-orchestrator-workflow.cjs"), "utf8");
  const inspection = source.indexOf('reason_code: "read_only_inspection"');
  const native = source.indexOf('reason_code: "native_review"');
  const reviewer = source.indexOf("await askApprover({ approver, mission, approval, judge: judges, check, signal, verifyCurrent })");
  assert.ok(inspection > 0 && native > inspection && reviewer > native, "native review sits between inspection and the reviewer");
});
