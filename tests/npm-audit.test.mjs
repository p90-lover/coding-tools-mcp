import assert from "node:assert/strict";
import test from "node:test";
import { unexplained } from "../scripts/npm-audit.mjs";

const advisory = (id, severity = "low") => ({ source: 1, url: `https://github.com/advisories/${id}`, severity, title: id });
// The shape `npm audit --json` gave for deepmerge on 2026-10-28: one advisory, three packages depending on it.
const deepmergeChain = {
  deepmerge: { severity: "low", via: [advisory("GHSA-gcqx-w48m-w2h4")] },
  "@sveltejs/vite-plugin-svelte": { severity: "low", via: ["deepmerge"] },
  "@sveltejs/kit": { severity: "low", via: ["@sveltejs/vite-plugin-svelte"] },
  "@sveltejs/adapter-static": { severity: "low", via: ["@sveltejs/kit"] },
};

test("an allowed advisory explains its package and every package that depends on it", () => {
  assert.deepEqual(unexplained({ vulnerabilities: deepmergeChain }), []);
});

test("any other advisory still fails, including one reached through an allowed package's dependents", () => {
  const report = { vulnerabilities: {
    ...deepmergeChain,
    "@sveltejs/kit": { severity: "moderate", via: ["@sveltejs/vite-plugin-svelte", advisory("GHSA-xxxx-yyyy-zzzz", "moderate")] },
    lodash: { severity: "high", via: [advisory("GHSA-aaaa-bbbb-cccc", "high")] },
  } };
  assert.deepEqual(unexplained(report).map((entry) => entry.name).sort(), ["@sveltejs/adapter-static", "@sveltejs/kit", "lodash"]);
});

test("the allowlist is only for the advisories it names", () => {
  assert.deepEqual(unexplained({ vulnerabilities: deepmergeChain }, new Map()).map((entry) => entry.name).sort(),
    ["@sveltejs/adapter-static", "@sveltejs/kit", "@sveltejs/vite-plugin-svelte", "deepmerge"]);
});
