#!/usr/bin/env node
"use strict";

import { spawnSync } from "node:child_process";

// Unfixed upstream advisories that would otherwise fail every CI run.
// Drop an entry once a patched release is in the lockfile.
const ALLOWED = new Map([
  [
    "GHSA-fc5q-39xc-vjpf",
    "picomatch <=4.0.7 ReDoS; no patched npm release as of 2026-11-18 (micromatch/picomatch#194)",
  ],
]);

const audit = spawnSync("npm", ["audit", "--audit-level=low", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
  maxBuffer: 20 * 1024 * 1024,
});

if (audit.error) {
  console.error(audit.error);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout || "{}");
} catch {
  console.error(audit.stdout || audit.stderr || "npm audit produced no JSON");
  process.exit(audit.status === 0 ? 0 : (audit.status ?? 1));
}

function canon(id) {
  return String(id || "").toUpperCase();
}

const found = new Map();
for (const info of Object.values(report.vulnerabilities || {})) {
  for (const item of info.via || []) {
    if (!item || typeof item !== "object") continue;
    const text = String(item.url || item.source || "");
    const match = text.match(/GHSA-[0-9a-z-]+/i);
    if (!match) continue;
    const id = match[0];
    found.set(canon(id), {
      id,
      title: item.title || info.name,
      severity: item.severity || info.severity,
    });
  }
}

const unexpected = [...found.values()].filter((item) =>
  ![...ALLOWED.keys()].some((allowed) => canon(allowed) === canon(item.id)));

if (unexpected.length) {
  console.error("npm audit found advisories that are not on the allow list:");
  for (const item of unexpected) {
    console.error(`- ${item.id} (${item.severity}): ${item.title}`);
  }
  process.exit(1);
}

if (found.size) {
  console.log("npm audit: no new advisories. Allowed unfixed upstream issues:");
  for (const [id, reason] of ALLOWED) {
    if (found.has(canon(id))) console.log(`- ${id}: ${reason}`);
  }
  process.exit(0);
}

if (audit.status) {
  console.error(audit.stderr || audit.stdout || `npm audit exited ${audit.status}`);
  process.exit(audit.status);
}

console.log("npm audit: no vulnerabilities at the configured audit level.");
