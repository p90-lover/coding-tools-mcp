#!/usr/bin/env node
// `npm audit --audit-level=low` with a short, explicit list of advisories CI may skip.
//
// Every advisory fails the build unless it is listed in ALLOWED below, with the reason it is safe
// to skip and when the entry must go. An allowed advisory still fails the build once npm can fix it
// without a breaking change (`fixAvailable: true`): then the lockfile is updated and the entry
// removed, rather than the skip living on unnoticed.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ALLOWED = new Map([
  // picomatch ReDoS through single-branch repeated extglobs (high). Updated 2026-11-17 to cover every
  // release through 4.0.7, the newest, with no patched version. Here it is reached only through
  // the root's dev toolchain (vite 8 via tinyglobby/fdir, svelte-check, @sveltejs/kit), which globs
  // the repository's own config patterns, never outside input. The only automatic fix downgrades
  // vite to 6.2.7. Skipped at the user's choice on 2026-11-18 (PR #1335). Remove once picomatch
  // ships a fixed release (this script then fails with fixAvailable).
  ["GHSA-fc5q-39xc-vjpf", { packages: ["picomatch"] }],
]);

const advisoryId = (url) => /GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/i.exec(String(url ?? ""))?.[0] ?? null;

/**
 * What in an `npm audit --json` report must fail the build: advisories not in `allowed` (or listed
 * for another package), and allowed ones npm can now fix without a breaking change. Also returns
 * the allowed advisories it skipped, to print.
 */
export function auditFindings(report, allowed = ALLOWED) {
  if (!report || typeof report !== "object" || report.error || typeof report.vulnerabilities !== "object" || !report.vulnerabilities) {
    return { failures: [`npm audit gave no usable report: ${JSON.stringify(report?.error ?? report).slice(0, 300)}`], skipped: [] };
  }
  const failures = [], skipped = new Set();
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    for (const via of Array.isArray(entry?.via) ? entry.via : []) {
      if (typeof via !== "object" || via === null) continue; // a dependency path; its own advisory is listed under its name
      const id = advisoryId(via.url);
      const rule = id ? allowed.get(id) : undefined;
      if (!rule || !rule.packages.includes(via.name ?? name)) {
        failures.push(`${via.name ?? name}: ${via.severity ?? entry.severity} ${id ?? via.url ?? "advisory"} ${via.title ?? ""}`.trim());
        continue;
      }
      skipped.add(id);
      if (entry.fixAvailable === true) failures.push(`${name}: ${id} can now be fixed without a breaking change; run npm audit fix and remove it from ALLOWED`);
    }
  }
  return { failures, skipped: [...skipped] };
}

function main() {
  let output;
  try {
    output = execFileSync("npm", ["audit", "--json", "--audit-level=low"], { encoding: "utf8", maxBuffer: 64 << 20, shell: process.platform === "win32" });
  } catch (error) {
    output = error.stdout; // npm audit exits 1 whenever it finds anything
  }
  let report;
  try { report = JSON.parse(output); } catch { report = { error: `unparsable npm audit output: ${String(output).slice(0, 200)}` }; }
  const { failures, skipped } = auditFindings(report);
  for (const id of skipped) console.log(`::warning::npm audit: skipped allowed advisory ${id} (see scripts/npm-audit.mjs)`);
  if (failures.length) {
    for (const line of failures) console.error(`npm audit: ${line}`);
    process.exit(1);
  }
  console.log(`npm audit: no advisories beyond the ${skipped.length} allowed`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
