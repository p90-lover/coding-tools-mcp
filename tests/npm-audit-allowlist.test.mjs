import assert from "node:assert/strict";
import test from "node:test";
import { ALLOWED, auditFindings } from "../scripts/npm-audit.mjs";

// Shaped like `npm audit --json` (npm 7+) on 2026-11-18: picomatch's own advisory, and the packages
// that pull it in, listed by name only.
const advisory = (name, id, severity = "high") => ({ source: 1, name, dependency: name, title: `${name} advisory`,
  url: `https://github.com/advisories/${id}`, severity, range: "<=4.0.7" });
const report = (vulnerabilities) => ({ auditReportVersion: 2, vulnerabilities, metadata: {} });
const picomatch = { name: "picomatch", severity: "high", isDirect: false, via: [advisory("picomatch", "GHSA-fc5q-39xc-vjpf")],
  effects: ["fdir", "tinyglobby", "vite"], range: "*", nodes: ["node_modules/picomatch"],
  fixAvailable: { name: "vite", version: "6.2.7", isSemVerMajor: true } };
const vite = { name: "vite", severity: "high", isDirect: true, via: ["picomatch", "tinyglobby"], effects: [], range: ">=6.3.0-beta.0",
  nodes: ["node_modules/vite"], fixAvailable: { name: "vite", version: "6.2.7", isSemVerMajor: true } };

test("the allowed picomatch advisory and the packages that only pull it in pass, and say so", () => {
  assert.deepEqual(auditFindings(report({ picomatch, vite })), { failures: [], skipped: ["GHSA-fc5q-39xc-vjpf"] });
});

test("any other advisory still fails the build, at every severity", () => {
  for (const severity of ["low", "moderate", "high", "critical"]) {
    const other = { name: "devalue", severity, via: [advisory("devalue", "GHSA-aaaa-bbbb-cccc", severity)], fixAvailable: true };
    const { failures } = auditFindings(report({ picomatch, devalue: other }));
    assert.equal(failures.length, 1, severity);
    assert.match(failures[0], /^devalue: .*GHSA-aaaa-bbbb-cccc/);
  }
});

test("the allowed advisory fails again once npm can fix it without a breaking change", () => {
  const { failures } = auditFindings(report({ picomatch: { ...picomatch, fixAvailable: true } }));
  assert.match(failures.join("\n"), /GHSA-fc5q-39xc-vjpf can now be fixed without a breaking change/);
});

test("an allowed id raised for another package, or an unusable report, fails", () => {
  const moved = { name: "minimatch", severity: "high", via: [advisory("minimatch", "GHSA-fc5q-39xc-vjpf")], fixAvailable: false };
  assert.equal(auditFindings(report({ minimatch: moved })).failures.length, 1);
  assert.equal(auditFindings({ error: { code: "ENOLOCK" } }).failures.length, 1);
  assert.equal(auditFindings(null).failures.length, 1);
});

test("the allow-list stays short and names its packages", () => {
  assert.ok(ALLOWED.size <= 3, "an allow-list that grows is no longer an audit");
  for (const [id, rule] of ALLOWED) {
    assert.match(id, /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/);
    assert.ok(rule.packages.length > 0, id);
  }
});
