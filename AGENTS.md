<!-- mcp-probe:context begin — auto-generated; re-run init_project_context updates this block only -->
<!-- mcp-probe:context-version: 4.0.2 -->
## MCP（必须先调）
需已配置 mcp-probe-kit。写代码前先读 Skill：@.agents/skills/mcp-probe-kit/SKILL.md（或 [MCP 调用时机](.agents/skills/mcp-probe-kit/SKILL.md)）（首次 MCP 调用自动创建 Skill 文件）。

- 用户只说“继续 / 开始 / 往下做” → **先调用 `resume_plan`**；已知 `plan_id` 则传入，未知则只传 `project_root` 自动恢复最近的 active/blocked Plan；未确认无可恢复 Plan 前，禁止先用 Bash 探索、调用 `workflow` 或重新调用 `start_*`；恢复成功且 `mustContinue=true` 后禁止只汇报“已恢复”，必须立即执行 `nextStep/nextTool`，每步后调用 `plan_heartbeat`，直到阻断、取消或收敛
- 不确定用哪个 MCP → `workflow`（只返回工具选择指南；由 Agent 自己判断，必要时再澄清）
- 当前会话看不到 MCP 工具 → 读取 Skill 的“执行通道与自动降级”，通过 `.mcp-probe-kit/bin/probe.*` 调用同版本 CLI；不要要求用户安装
- 新功能 → `start_feature`（会先搜记忆）
- Bug → `start_bugfix`（会先搜记忆）
- UI → `start_ui`（会先搜记忆）
- 不熟代码 / 影响面 → `code_insight`（context / impact / auto）
- 缺上下文 → `init_project_context`
- 提交 → `gencommit`

上下文：写代码前先读 [project-context](./docs/project-context.md)（链到 `docs/project-context/` 各文档）
图谱：大改前读 [latest](./docs/graph-insights/latest.md)；过期 `code_insight` mode=auto save_to_docs=true
记忆（需 MEMORY_QDRANT_URL 等已配置）：
- 检索：`start_*` 命中后**自动注入**历史经验全文；中途补查可用 `search_memory`；单条精读仍可用 `read_memory_asset`
- 沉淀：跨仓库共享**勿填** source_project/source_path；路径写进 content；summary 写检索关键词
- 修正：已有资产可用 `update_memory_asset` 按 asset_id 原地更新（保留 ID）
- 清理：过时/错误/重复沉淀可用 `delete_memory_asset`（删除前建议 `read_memory_asset` 确认）
- Bug 每轮验证后先准备成功/失败/证伪/回归候选并写入 `plan_heartbeat`；`converge` 通过后再 `memorize_asset`
- 功能/UI 验证后先准备候选并写入 `plan_heartbeat`；`converge` 通过后再 `memorize_asset` type=`pattern`/`component`
<!-- mcp-probe:context end -->

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **coding-tools-mcp** (32223 symbols, 80764 relationships, 898 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/coding-tools-mcp/context` | Codebase overview, check index freshness |
| `gitnexus://repo/coding-tools-mcp/clusters` | All functional areas |
| `gitnexus://repo/coding-tools-mcp/processes` | All execution flows |
| `gitnexus://repo/coding-tools-mcp/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

## GitHub delivery

- **Standing user authorization:** unless the user explicitly asks otherwise, deliver installer-affecting changes end to end: verify → commit → push → pull request → passing applicable checks → merge to `main` → new version/build → verified published release. Do not ask the user to repeat permission for this normal delivery sequence.
- **Do not stop at “PR open”, “CI running” or “build queued”.** Those are progress updates, not completion. Continue through publication and verify the release tag, exact source, downloadable assets and checksums; report the release/installer URL. If work is genuinely blocked, name the blocker and save a resumable checkpoint instead of claiming success.
- Keep each PR scoped to its task. Do not merge unrelated, unverified or another owner's unfinished work, and never publish credentials or temporary artifacts. Coordinate one release owner and batch compatible verified merges into one build rather than creating competing releases.
- Follow the detailed delivery workflow below, including its docs-only exception. Documentation/instruction-only changes still require a PR and merge, but do not need a redundant installer rebuild when packaged code is unchanged.
- CI, authentication, disabled Actions, permissions and billing failures are real blockers, not permission to force-merge, skip verification, change account settings or report a release that does not exist. The one exception is **Releasing while GitHub Actions is blocked** below, and only after the user explicitly chooses it. An already-successful build may be published only after verifying its exact source provenance and asset checksums. Installation, patching or restarting the user's running app still requires their separate request.

## Storage: never the C: drive

- Do not use the C: drive for storage: no builds, caches, scratch, test fixtures, downloads, backups, logs, installer temp or rollback copies. The project, its worktrees and the app's data live on G:; the installed app lives on H:.
- Never fall back to C:. `os.tmpdir()`, `%TEMP%`, `%TMP%` and `%LOCALAPPDATA%` point at C: on this machine, so code and scripts must not default to them. Use an explicit root on the project's or the app's drive (the repo's `aiTemp/`, the app's data root) and fail loudly when none is set.
- A silent install (`/S /D=H:\Apps\Coding Tools`) copies the old install to `%TEMP%` as a rollback: set `TEMP`/`TMP` to a folder on H: (outside the install folder) before running it.
- Keep scratch, backups and Trash out of `H:\Apps\Coding Tools`: every update copies that whole folder.

## Delivery: every change ships as a release

Every agent working in this repository follows this: Claude Code, Codex, opencode and Coding Tools' own chat agents. A task with file changes is not done until its change is merged and released.

1. **Pull request.** Every change goes into a pull request against `main`. Never push to `main` directly. Never leave a change only in a worktree or as uncommitted edits. One PR per task, pushed as few times as possible: this repository's GitHub Actions were once suspended for using too much compute.
2. **Merge.** Once the PR's required checks pass, merge it yourself. Don't leave it open for someone else unless the user said to wait. Fix a failing check and push again. Don't re-run CI in a loop.
3. **Plugins.** Plugin repositories, for example `G:\Projects\cpa_provider_manager` (`p90-lover/cpa_provider_manager`) and `G:\Projects\cpa-helper-plugin`, follow the same steps in their own repository: PR, merge to its `main`, then that plugin's release. If this app pins or bundles the plugin, the app's update is a separate PR here.
4. **Release.** After a merge to `main`, release a new version:
   - First check that no release is already under way:
     - `gh pr list --state open --search "release: in:title"`
     - `gh run list --workflow electron-windows-release.yml --limit 3`

     If a release PR is open or a `workflow_dispatch` run is in progress, do not start a competing release. Coordinate with its owner and verify that your change is actually included in the pinned build commit. An unrelated or older release is not a reason to abandon delivery; queue changes that miss the cutoff for the next release and report their true state.
   - Open a version-bump PR titled `release: 0.8.x`. It changes the version line in `desktop-electron/electron/product.cjs`, `desktop-electron/package.json`, `desktop-electron/scripts/prepare-package-resources.cjs`, `desktop-electron/scripts/verify-package.cjs`, `desktop-electron/tests/product-identity.test.cjs` and `desktop-electron/tests/rc12-release-identity.test.cjs`, plus new notes in `docs/releases/v0.8.x.md` (English and 繁體中文). Search `desktop-electron` for the old version to catch every line, but leave the `@xmldom/xmldom` override in `package.json` alone. Merge it once green.
   - Publish from CI: `gh workflow run electron-windows-release.yml --ref main -f publish=true`. CI builds, verifies and publishes the installer. Don't build a release installer locally.
   - Merges that land close together share one release.
   - A change that ships nothing in the installer (agent instructions, docs, CI-only files) needs no release of its own. The next release carries it.
5. **Local builds** (`bun run package:win`) only when the user asks for an installer on this machine:
   - Run one build at a time.
   - `G:\Projects\coding-tools-worktrees\ct-build` is shared: check its `git reflog` and look for running `electron-builder`/`cargo`/`bun` processes there first.
   - Build at low I/O priority, because the installed app runs from the same disk and freezes during a full-priority build.
6. **The installed app.** Never install over, patch or restart the user's installed app (`H:\Apps\Coding Tools`) unless the user asks.

### Releasing while GitHub Actions is blocked

GitHub sometimes stops running workflows for this repository at the account level. `gh workflow run` then answers `HTTP 422: Actions has been disabled for this repository`, PRs show no checks and stay `BLOCKED`, and `actions/runs?head_sha=<head>` is 0, even though `actions/permissions` still says enabled. The user's repository settings don't fix it: it's the account's Actions billing, spending limit or a GitHub compute flag.

1. **Report it and ask.** Tell the user, and don't re-trigger CI in a loop. Wait for Actions unless the user explicitly chooses to bypass CI. Their choice covers that one release.
2. **Merge as admin.** Run `gh pr merge <n> --admin --merge`, one PR at a time, smallest and most independent first, with the version-bump PR last. Re-check `mergeable` before each merge and stop at the first conflict. In PowerShell 5.1, `gh --jq` expressions containing spaces or quotes break ("accepts at most 1 arg"), so run these from bash.
3. **Release notes.** One `docs/releases/v0.8.x.md` covers every merged PR. Its verification section says the release was built locally without CI.
4. **Test locally instead of CI.** On the merged `main`, run the desktop Electron suite (`node --test desktop-electron/tests/*.cjs`) at low I/O priority, plus the release identity tests. A failure blocks the release. Fix it in a PR and admin-merge that too.
5. **Build like the release workflow.** Follow `.github/workflows/electron-windows-release.yml` on the exact merged commit, in `ct-build` (see step 5 above: reflog, running processes, low I/O priority, at least 3 GB free on G:):
   - `git submodule update --init`;
   - `bun install --frozen-lockfile` in `runtime-web`, `runtime-web/launcher` and `desktop-electron`;
   - the checksum-pinned tunnel-client archive the workflow names;
   - `cargo build --release --locked` for `rust-core/coding-tools-headless`;
   - `bun run --cwd desktop-electron package:win`.

   Then check what the workflow checks: `Coding.Tools_<ver>_win_x64_portable.zip`, `_update.json`, `*.ctpack` and `SHA256SUMS.txt` exist; delete `*.blockmap`; append the `.exe` hash to `SHA256SUMS.txt`; and `sha256sum -c SHA256SUMS.txt` passes.
6. **Publish by hand, draft first.** The in-app updater skips drafts.
   - `gh release create v<ver> --target <merged commit> --draft --title "Coding Tools v<ver>" --notes-file docs/releases/v<ver>.md <artifacts>/*`
   - Download it back with `gh release download` and run `sha256sum -c SHA256SUMS.txt` on the copies.
   - Only then run `gh release edit v<ver> --draft=false --latest`.
7. **Clean up.** Delete the build's dated `aiTemp/Trash` folders in `ct-build`. Tell the user the release was built and tested locally, not by CI.

## xyTom 0.3 integration invariants

- `old/` is a lossless source snapshot pinned by `old/UPSTREAM_SNAPSHOT.md` to `xyTom/coding-tools-mcp` 0.3.0. Never delete prior snapshot files: move replaced or upstream-removed content under `old/Trash/` and use `aiTemp/` for synchronization/build artifacts.
- When MCP `_meta.openai/session` is present, the first non-history tool call automatically creates or resumes the matching `docs/history-session/` archive. Explicit `history_session_bootstrap` remains the path for clients without metadata and for verbatim `initial_user_input` capture. Per-turn `history_session_checkpoint` is still required.
- Every shared `call_tool` result must carry bounded, path-aware `project_instructions`. Resolve the primary workspace and each approved `@alias` linked project as separate scopes; recognize case-insensitive `AGENTS.md`, `agent.md`, and `CLAUDE.md`; never load instructions from unapproved external paths.
- `command_id`, `kill_command`, and `command:<id>:stdout|stderr` are canonical. Preserve the existing `session_id`, `kill_session`, and `session:<id>:...` aliases until an explicit breaking release. Completed output must remain readable for the documented bounded retention window.
- Before merging this integration, run the Rust test/clippy/fmt suite, the Svelte check/build and Node tests.
