#!/usr/bin/env node
// `npm audit --audit-level=low`, except for advisories listed below. Each one needs a reason and
// stays printed on every run, so it is removed once a patched release exists.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const ALLOWED = new Map([
  ["GHSA-gcqx-w48m-w2h4", "deepmerge has no patched release (every version 4.2.0–4.3.1 is affected). It reaches us only"
    + " through @sveltejs/vite-plugin-svelte at build time, merging our own Svelte config, never untrusted input."],
]);

const LEVELS = ["info", "low", "moderate", "high", "critical"];

/** The vulnerable packages `npm audit --json` reports that are not explained by allowed advisories. */
export function unexplained(report, allowed = ALLOWED, minimum = "low") {
  const vulnerabilities = report.vulnerabilities ?? {};
  const memo = new Map();
  // A package is explained when every advisory it carries is allowed and every package it gets a
  // vulnerability through is explained as well.
  const explained = (name, seen = new Set()) => {
    if (memo.has(name)) return memo.get(name);
    if (seen.has(name)) return true;
    seen.add(name);
    const entry = vulnerabilities[name];
    const result = !entry || entry.via.every((via) => typeof via === "string"
      ? explained(via, seen)
      : allowed.has(String(via.url ?? "").split("/").pop()));
    memo.set(name, result);
    return result;
  };
  return Object.entries(vulnerabilities)
    .filter(([, entry]) => LEVELS.indexOf(entry.severity) >= LEVELS.indexOf(minimum))
    .filter(([name]) => !explained(name))
    .map(([name, entry]) => ({ name, severity: entry.severity }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let output;
  try {
    output = execFileSync("npm", ["audit", "--json"], { encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // npm audit exits non-zero whenever it finds anything; the report is still on stdout.
    output = error.stdout;
    if (!output) throw error;
  }
  const report = JSON.parse(output);
  for (const [id, reason] of ALLOWED) console.log(`allowed ${id}: ${reason}`);
  const left = unexplained(report);
  if (left.length > 0) {
    console.error("npm audit found vulnerabilities that no allowed advisory explains:");
    for (const { name, severity } of left) console.error(`  ${name} (${severity})`);
    try { execFileSync("npm", ["audit", "--audit-level=low"], { stdio: "inherit", shell: process.platform === "win32" }); } catch { /* the full report */ }
    process.exit(1);
  }
  console.log(`npm audit: nothing at low or above beyond the ${ALLOWED.size} allowed advisory(ies).`);
}
