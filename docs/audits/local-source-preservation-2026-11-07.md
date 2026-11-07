# Local source preservation — 2026-11-07

The user explicitly approved publishing screened historical source snapshots as archival branches in `p90-lover/coding-tools-mcp`, without merging stale snapshots into the release.

## Verified GitHub backups

- 12 archive branches, covering 247 source paths from historical project checkouts.
- Every published head below was read back with `git ls-remote` and matches the prepared commit.
- Original checkouts, their HEADs, and their staging indexes were not replaced or reset.

| Original source branch | Archive branch | Verified commit | Source paths |
| --- | --- | --- | --- |
| `codex/register-cpa-integration` | [`archive/local-20261107/repo-34c587`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/repo-34c587) | `b4ae34d21a3863225de6b3c7dfabce105ae27d8f` | 87 |
| `fix/provider-manager-usage-surface` | [`archive/local-20261107/primary-99f79b`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/primary-99f79b) | `298c7147ff32f8e315e4ba3f855cceeb6324768d` | 60 |
| `codex/antigravity-coding-filter` | [`archive/local-20261107/worktree-adb99d`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/worktree-adb99d) | `72e9bedfeaf1f7d843e6ef55e3d18de9133bd27a` | 14 |
| `codex/composer-tabs-20261026` | [`archive/local-20261107/repo-1e9658`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/repo-1e9658) | `0af227b790ae97def166ec46570b2329d6205d4f` | 7 |
| `codex/cancel-disposed-agent-prewarm-20261103` | [`archive/local-20261107/prewarm-dispose-fix-cd4216`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/prewarm-dispose-fix-cd4216) | `f1acf24892c3f4e1026eecdd2758475b0c60429d` | 2 |
| `codex/fence-provider-probe-results-20261103` | [`archive/local-20261107/provider-probe-ownership-fix-dae523`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/provider-probe-ownership-fix-dae523) | `baa985d7c67ac518c411b90b010127a5b0476bf1` | 2 |
| `fix/mcp-approved-execution` | [`archive/local-20261107/pr-88a7af`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/pr-88a7af) | `635673452ef98cd5c746927cfdebec9e61f419c7` | 2 |
| `codex/gpt6-effort-delivery-20261102` | [`archive/local-20261107/gpt6-effort-delivery-20261102-dea0e2`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/gpt6-effort-delivery-20261102-dea0e2) | `92c7a829e692ad9ce55cb45644383cd68a27c626` | 24 |
| `codex/fix-missing-response-display-20261102` | [`archive/local-20261107/missing-response-display-20261102-5ad7ba`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/missing-response-display-20261102-5ad7ba) | `5ebb55d91579a2210432d8eb1958f89cb3aaed39` | 1 |
| `detached verification snapshot` | [`archive/local-20261107/mirror-03f48f`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/mirror-03f48f) | `663497cc537cd994b012135cac02919eca93aed0` | 42 |
| `fix/approval-attribution` | [`archive/local-20261107/claude-sidebar-560cda`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/claude-sidebar-560cda) | `514c06d34a811eceb287804d012e75fbe322d5a2` | 4 |
| `detached verification snapshot` | [`archive/local-20261107/webgpt-broker-fix-24db08`](https://github.com/p90-lover/coding-tools-mcp/tree/archive/local-20261107/webgpt-broker-fix-24db08) | `8faa935c0677f8ab9837133bcbaf1598e8ed4f04` | 2 |

## Release boundary

These are preservation commits, **not release candidates**. Some original checkouts predate newer fixes on main, and some are task verification mirrors. They must not be merged merely to make a working tree appear clean. Reviewed current PRs are integrated separately.

Excluded: credentials/live configuration, hidden agent/probe state, browser profiles, generated bundles, build artifacts, logs, traces and temporary files. A conservative source-token/private-key scan found no flagged selected files; that heuristic is not a claim of a complete security review. Active owner changes were left with their owners and published through their normal PRs.

The registry audit found 91 linked checkouts, 21 with recorded changes and four stale/unavailable entries. Unavailable entries could not be inspected; no source was deleted. The archive list covers the available selected historical product source, not a claim to back up every ignored file on the machine.

## Graph checks

The archival aggregate was indexed twice; the second pass increased the file limit to include seven large workflow/test files skipped initially. Change analysis reported 247 paths, 1,824 symbols, 394 reported processes and CRITICAL risk in the repeated change check. Process/dispatch caps still leave incomplete flow coverage. This is further reason to preserve rather than blindly ship these snapshots; it is not a clean whole-app all-clear.
