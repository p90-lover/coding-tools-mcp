"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const desktopRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
);
const installer = fs.readFileSync(
  path.join(desktopRoot, "build", "installer.nsh"),
  "utf8",
);

test("assisted installer can elevate when a legacy per-machine MSI needs removal", () => {
  assert.equal(manifest.build.nsis.oneClick, false);
  assert.equal(manifest.build.nsis.perMachine, false);
  assert.equal(manifest.build.nsis.allowElevation, true);
});

test("legacy migration enumerates exact-name MSI registrations in every registry view", () => {
  assert.match(installer, /!define LEGACY_UNINSTALL_ROOT/);
  assert.match(installer, /EnumRegKey/);
  assert.match(installer, /ReadRegDWORD[^\n]*WindowsInstaller/);
  assert.match(installer, /DisplayName/);
  assert.match(installer, /Coding Tools MCP/);
  assert.match(installer, /StrLen[^\n]*LegacySubKeyLength/);
  assert.match(installer, /LegacySubKeyLength[^\n]*38/);
  assert.match(installer, /LegacyFirstChar[^\n]*\{/);
  assert.match(installer, /LegacyLastChar[^\n]*\}/);

  for (const root of ["HKCU", "HKLM"]) {
    for (const view of ["64", "32"]) {
      assert.ok(
        installer.includes(`!insertmacro MigrateLegacyInstall ${root} ${view}`),
        `missing ${root} ${view}-bit legacy scan`,
      );
    }
  }
});

test("MSI migration invokes only the system Windows Installer and handles restart success", () => {
  assert.match(installer, /!define LEGACY_MSIEXEC "\$SYSDIR\\msiexec\.exe"/);
  assert.match(installer, /ExecWait[^\n]*LEGACY_MSIEXEC[^\n]*\/x/);
  assert.match(installer, /ExecWait[^\n]*\/qn[^\n]*\/norestart/);
  assert.match(installer, /LegacyExitCode[^\n]*3010/);
  assert.match(installer, /LegacyExitCode[^\n]*0/);
  assert.match(installer, /legacy MSI uninstall failed/i);
  assert.doesNotMatch(installer, /DeleteRegKey/i);
  assert.doesNotMatch(installer, /RMDir\s+\/r/i);
});

test("focused Windows gate uses an overridable MSI executable fixture", () => {
  const workflowPath = path.resolve(
    desktopRoot,
    "..",
    ".github",
    "workflows",
    "legacy-msi-upgrade-ci.yml",
  );
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assert.match(workflow, /windows-latest/);
  assert.match(workflow, /create-legacy-msi-upgrade-fixture\.ps1/);
  assert.match(workflow, /makensis\.exe/);
  assert.match(workflow, /LEGACY_MSIEXEC/);
  assert.match(workflow, /legacy-msiexec-ran\.txt/);
  assert.match(workflow, /git diff --diff-filter=D/);
});
