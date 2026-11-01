# Upgrade recovery verification

Local fixes installed on Coding Tools 0.7.0-rc.25 on 2026-10-19 (Asia/Shanghai). The app relaunched through its normal updater. The final app and backend processes respond.

## Verified results

- All 188 existing controller tests passed across the workflow, upstream adapter, and subagent suites.
- The exact release backend completed 75 concurrent profile transactions across three isolated processes. All three readers and the saved file contained all 75 records. All test children stopped.
- The original affected run's cancellation previously failed with `Profile persistence (create temporary file): The file exists. (os error 80)`. After installation it returned HTTP 200 and persisted `cancelled: true`, revision 11.
- Installed archive, backend, component manifest, and update inventory match the staged hashes. All 12,761 unrelated inventory entries and the installed profile resolver were preserved.
- The package changes exactly three runtime JavaScript modules; all 1,140 other archive files and unpacked contents were verified unchanged.
- Official rc.25 Terminal/session and file-listing changes were retained.

The storage fix combines an OS file lock across the full profile transaction with canonical Windows state-directory resolution. The earlier lock-only backend still failed exclusive temporary-file creation through the redirected roaming path.

Stop now exits owned agents and descendants, including idle completed children, reports real shutdown failures, preserves a session reused by a newer run, and coalesces concurrent release requests.

## Verification boundary

The live cancellation check proves saved cancellation, not UI process shutdown or Restart. Desktop UI control and native screenshot capture are unavailable in this session. A manual Stop/Restart check was requested and remains pending. Full single/team, all-tools, provider inference, and UI end-to-end success are not claimed.

The MCP convergence gate remains blocked only on that unverified manual acceptance item. No long-term memory asset was written.

## Installed identity

- App archive: `3604d63d111159a2c87c73be61f51de8201c088a3045c95b874ee5e14fe43773`
- Release backend: `656e571ec42609d4a328d5fe9c69ea7d55cb05baa7751379c9e4ba1cb4fde3a7`, 21,373,952 bytes
- Component manifest: `d1f9908ee68c8ac39ed10238566ad5fb0aab7a98be459471f3007aaaf227cbf2`
- Snapshot process IDs: app 166200, backend 36164
- Scoped source patch against rc.25: [recovery.patch](G:/Projects/coding-tools-mcp/aiTemp/upgrade-agent-recovery/aiTemp/recovery.patch)
- Evidence: [installed verification](G:/Projects/coding-tools-mcp/aiTemp/upgrade-agent-recovery/aiTemp/installed-verification.json), [concurrent saves](G:/Projects/coding-tools-mcp/aiTemp/upgrade-agent-recovery/aiTemp/backend-validation-result.json), [live cancellation](G:/Projects/coding-tools-mcp/aiTemp/upgrade-agent-recovery/aiTemp/stop-live-final.json), [archive verification](G:/Projects/coding-tools-mcp/aiTemp/upgrade-agent-recovery/aiTemp/asar-candidate-attestation.json)

This is a local patch, not a newly published official release. The scoped patch and source worktree are retained for review.

## Storage and cleanup

G: has 2,271,068,160 bytes free (about 2.27 GB, decimal) at the final check. Compression reclaimed about 1.17 GB from the inactive compiler cache. The incomplete duplicate cache and task-created compiler outputs were cleaned through Cargo. Remaining reusable dependencies were restored to `G:/Projects/coding-tools-mcp/target-headless`; no task build process remains.

Rollback files are preserved at `G:/Projects/coding-tools-mcp/Trash/upgrade-agent-recovery-20261019-1706`: 61,352,840 bytes, including a restore manifest.

Unified Agent Tools blocks permanent deletion through its command guard. Recoverable cleanup moved the following completed artifacts to Trash; these moves did not reclaim their 204,505,172 bytes. All original task paths are absent. Source proof, logs, final evidence, and other tasks' active work remain.

All paths below start at `G:/Projects/coding-tools-mcp/Trash/unified-agent-tools-moved/`:

| Retained relative path | Bytes |
| --- | ---: |
| 2026-10-18T17-14-19-250Z-31e6c351/aiTemp/upgrade-agent-recovery/aiTemp/backend-validation | 8,349,471 |
| 2026-10-18T17-14-20-168Z-9b0cc602/aiTemp/upgrade-agent-recovery/aiTemp/installed-merge | 194,087,258 |
| 2026-10-18T17-14-21-063Z-4f2acee5/aiTemp/upgrade-agent-recovery/aiTemp/atomic-save-race-fixture | 419 |
| 2026-10-18T17-14-21-935Z-e9cf50b2/aiTemp/upgrade-agent-recovery/aiTemp/headless-path-probe.exe | 317,440 |
| 2026-10-18T17-14-22-706Z-e0bb4238/aiTemp/upgrade-agent-recovery/aiTemp/headless-path-probe.pdb | 1,748,992 |
| 2026-10-18T17-14-23-536Z-7c3ca235/aiTemp/upgrade-agent-recovery/aiTemp/compress-old-runtime-staging.ps1 | 1,592 |
| 2026-10-18T17-14-24-199Z-1f017f6a/aiTemp/upgrade-agent-recovery/aiTemp/compiler-temp | 0 |
