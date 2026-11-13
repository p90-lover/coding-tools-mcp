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

- **Batch changes on branches; one coordinated PR and GitHub build per release (user rule, 2026-11-14).** This replaces the older one-PR-per-task and separate-version-bump-PR defaults. Keep each task's implementation and related follow-ups on one reusable branch. Verify locally, then push the ready commits once; do not open a new PR or dispatch Actions for every small fix, notes update or version edit.
- **One release owner** collects compatible, verified task branches into `release/<version>`, includes the version bump and bilingual release notes, and opens one PR against `main`. Reuse an existing suitable PR instead of creating another. Only integrate changes whose owner has marked them ready; never scoop up unfinished work, credentials or temporary artifacts. Give the owner each task's source commit and focused verification receipt.
- **Standing delivery authorization still applies.** After the batch's required checks pass, merge its PR and publish the new version through GitHub Releases. Do not push directly to `main` except under the explicitly authorized unavailable-PR fallback below. Never waive failed checks, change repository protections, or bypass a real permission denial. Preserve explicit opt-outs. Separately hosted plugins use the same batching rule in their own repositories; non-GitHub projects are exempt.
- **One PR check cycle and one publication run; keep required gates intact.** CI runs on the coordinated PR, not again on the same merge to `main`. Task-branch pushes do not need manual CI dispatches. The Windows release workflow packages on publication dispatch, or builds without publishing when the workflow itself changes; a version bump alone does not trigger extra packaging. After merge, the release owner requests publication once. Do not dispatch again while a release is queued or running; inspect the existing run instead. Necessary fixes can require another check cycle, but never rerun unchanged checks just to create a green result.
- **Finish at a verified published release, not a branch, PR, merge or queued build.** Check the actual release source includes the task's commit, and verify its notes, downloadable assets and checksums. A task joining an active batch waits for that release; changes missing the cutoff belong to the next batch. Save a checkpoint and report genuine blockers honestly.
- **Docs, instructions and CI-only changes need no identical installer rebuild.** Include them in an existing batch or one small maintenance PR when no batch is open. The next installer release carries them. Installing, patching or restarting the running app still requires the user's separate request.
- **GitHub restrictions are not solved by renaming a branch.** Fewer PR-triggered jobs reduce compute use; branches do not bypass an account-level Actions suspension, quota, billing restriction or remote refusal. Report that blocker and follow the fallback below. Do not change account settings or claim unrun checks passed.

## Storage: never the C: drive

- Do not use the C: drive for storage: no builds, caches, scratch, test fixtures, downloads, backups, logs, installer temp or rollback copies. The project, its worktrees and the app's data live on G:; the installed app lives on H:.
- Never fall back to C:. `os.tmpdir()`, `%TEMP%`, `%TMP%` and `%LOCALAPPDATA%` point at C: on this machine, so code and scripts must not default to them. Use an explicit root on the project's or the app's drive (the repo's `aiTemp/`, the app's data root) and fail loudly when none is set.
- A silent install (`/S /D=H:\Apps\Coding Tools`) copies the old install to `%TEMP%` as a rollback: set `TEMP`/`TMP` to a folder on H: (outside the install folder) before running it.
- Keep scratch, backups and Trash out of `H:\Apps\Coding Tools`: every update copies that whole folder.

## Disk space: write once, clean up after yourself

G: and H: are one shared hard disk. It holds the project, every worktree, the build caches and the running app's own data. When it fills, the app breaks, not just your build: on 2026-11-11 G: reached 0 bytes during a release readback, and chat messages failed to send ("os error 112") until space was freed. Each run below is from this repository's history.

- **Check free space before heavy work, and stop when it is short.** `df -B1M /g` before a build (needs at least 3 GB), a full test suite or a cargo build. If space is short, clean up first. Never start one that would fill the disk.
- **Moving to Trash on the same drive frees nothing.** The build scripts move the previous output into `aiTemp/Trash/<date>-*` (about 1.4 GB per packaging run). Once the build it belongs to is verified or published, delete those folders, the `aiTemp/work/electron-package-win/builder-output-*` folders and old `desktop-electron/artifacts`. Check `git ls-files aiTemp/Trash` first: some Trash folders are tracked fixtures and stay.
- **Don't copy what you can stream or point at.**
  - Check a published release by streaming each asset into the hash (`gh release download <tag> --pattern <file> -O - | sha256sum`), not by downloading a second copy.
  - Don't copy installers into an extra staging folder, and don't keep backups of old builds or of the installed app. The GitHub release is the backup.
- **Worktrees:**
  - Reuse one worktree per task, including its follow-ups. Don't make a new worktree and branch for every fix.
  - Link `node_modules` by junction instead of installing a copy.
  - Remove your worktree once its PR has merged. Never `git worktree remove --force` one that holds junctions: git deletes through them into the shared `node_modules`. Unlink the junctions first (`cmd /c dir /AL /S /B <worktree>` lists them), then delete, then `git worktree prune`.
  - Subagent worktrees under `.claude/worktrees/` count too.
- **Caches go in one shared place.**
  - Go: `GOCACHE`, `GOMODCACHE` and `GOTMPDIR` under `G:\coding-tools-build-cache\{gocache,gomod,gotmp}`.
  - Cargo: reuse the checkout's `target`; don't create ad-hoc `CARGO_TARGET_DIR` folders. One headless debug build in `G:\aiTemp\cargo-headless` wrote 7.4 GB in a day, and nothing ever used it again.
  - After a cargo test run, `target/debug/incremental` can go.
- **Scratch belongs to a task.**
  - Keep a task's scratch in one folder (`G:\aiTemp\<task>`). Delete it when the task has shipped, except files a script or test still reads: grep for the path first.
  - Daemons don't log to files; keep their output in memory or in the pipe.
  - Test runs leave fixtures under the worktree's `aiTemp/`; delete them after the run.
- **One heavy disk job at a time.** A build, a full test suite, a cargo build, a bulk delete and a recursive `du` or `grep` over G: each slow the others many times over. They also freeze the running app, whose data is on the same disk: a 0.8.42 package step took 2 h 08 min next to a `du`, and 46 min alone.
  - Bound every scan with `timeout` and a narrow path.
  - Never walk `G:\AppData` or a whole worktree tree while the app is busy.
  - Run deletes in the background.
- **In the app's own code, don't write what hasn't changed.**
  - Compare before rewriting a file, and debounce state that changes often.
  - Batch streaming writes, and never flush synchronously on Electron main.
  - Prune what grows: old runtime versions, per-account browser data after the account is removed, and stray `*.tmp-*` files from interrupted atomic writes.
  - A rewrite that keeps the same bytes still costs a flushed write and, on main, a frozen window.

## Delivery: every change ships as a release

Every agent working in this repository follows this: Claude Code, Codex, opencode and Coding Tools' own chat agents. A task with file changes is not done until its change is merged and released.

1. **Task branches, then one batch PR.** Reuse your task branch for related fixes and follow-ups. Inspect the local diff and run proportionate checks before pushing its ready commits. Coordinate one release owner to merge the ready branches into `release/<version>` and open one PR against `main`, including the version bump and notes. Do not open separate task, notes and bump PRs for the same release. Reuse an already open suitable PR; never leave completed work only uncommitted or silently drop it from the batch. Use the fallback below only when PRs or Actions are unavailable.
2. **Verify and merge the batch.** Let CI check the ready PR; update that same branch for necessary fixes instead of creating more PRs or manual runs. Once its required checks pass, the release owner merges it. Check that merged `main` has the verified tree; if integration changes it, rerun only invalidated checks or the applicable required gate. Never waive a real failure or rerun CI in a loop. User-authorized unavailable-CI delivery is the exception below, not an excuse to ignore failed verification.
3. **Plugins.** Plugin repositories, for example `G:\Projects\cpa_provider_manager` (`p90-lover/cpa_provider_manager`) and `G:\Projects\cpa-helper-plugin`, follow the same batching, verification, merge and release steps in their own repository. If this app pins or bundles the plugin, include that verified pin or bundle update in the app's coordinated batch instead of opening another app PR for it.
4. **Release.** After a merge to `main`, release a new version:
   - First check that no release is already under way:
     - `gh pr list --state open --search "release: in:title"`
     - `gh run list --workflow electron-windows-release.yml --limit 3`

     If a release PR is open or a `workflow_dispatch` run is in progress, do not start a competing release. Coordinate with its owner and verify that your change is actually included in the pinned build commit. An unrelated or older release is not a reason to abandon delivery; queue changes that miss the cutoff for the next release and report their true state.
   - Include the version bump and notes in the same batch PR, titled `release: 0.8.x`; do not create an extra bump PR after merging each task. Update the version line in `desktop-electron/electron/product.cjs`, `desktop-electron/package.json`, `desktop-electron/scripts/prepare-package-resources.cjs`, `desktop-electron/scripts/verify-package.cjs`, `desktop-electron/tests/product-identity.test.cjs` and `desktop-electron/tests/rc12-release-identity.test.cjs`, plus new notes in `docs/releases/v0.8.x.md` (English and 繁體中文). Search `desktop-electron` for the old version to catch every line, but leave the `@xmldom/xmldom` override in `package.json` alone.
   - **Package and publish on GitHub, not on this machine (user rule, 2026-11-14: "do the package on github … to avoid slow hard disk").** After the batch merges, its owner runs `gh workflow run electron-windows-release.yml --ref main -f publish=true` once: GitHub's runner builds, verifies and publishes the installer. Inspect existing queued/running release jobs first; do not create another dispatch or build-only run for the same source. G: and H: are one old shared hard disk that the running app also uses. On 2026-11-13 a local `package:win` there stalled for over 30 minutes in the AO renderer's vite build while the disk sat at 0% idle (queue 24–51, up to 0.58 s per I/O), and that release never shipped. If Actions is disabled, see **Releasing while GitHub Actions is blocked** below.
   - Merges that land close together share one release.
   - A change that ships nothing in the installer (agent instructions, docs, CI-only files) needs no release of its own. The next release carries it.
5. **Local builds** (`bun run package:win`) only when the user asks for one in their own words, for that release or for an installer on this machine:
   - Run one build at a time.
   - `G:\Projects\coding-tools-worktrees\ct-build` is shared: check its `git reflog` and look for running `electron-builder`/`cargo`/`bun` processes there first.
   - Build at low I/O priority, because the installed app runs from the same disk and freezes during a full-priority build.
   - Check the disk first. If disk 2 (G:/H:) shows `% Idle Time` near 0 or a `Current Disk Queue Length` above about 10, wait and tell the user why. A stalled build holds `ct-build` and the disk slot for everyone.
6. **The installed app.** Never install over, patch or restart the user's installed app (`H:\Apps\Coding Tools`) unless the user asks.

### Releasing while GitHub Actions is blocked

GitHub sometimes stops running workflows for this repository at the account level. `gh workflow run` then answers `HTTP 422: Actions has been disabled for this repository`, PRs show no checks and stay `BLOCKED`, and `actions/runs?head_sha=<head>` is 0, even though `actions/permissions` still says enabled. The user's repository settings don't fix it: it's the account's Actions billing, spending limit or a GitHub compute flag.

1. **Report it and ask the user to re-enable Actions.** Tell the user CI is unavailable and that the installer waits for Actions, since it is packaged on GitHub (user rule, 2026-11-14). Do not re-trigger it in a loop. Merging still follows **Delivery fallback when PRs or Actions are unavailable** below (authorized 2026-11-07), so steps 2 and 3 here still apply. Steps 4–7 (local suite, build and publish) run only when the user asks for a local build of that release. Respect any later opt-out and stop for failed verification or a denied remote/tool action.
2. **Merge the verified batch.** If required CI is unavailable, not failing, the standing fallback authorizes `gh pr merge <n> --admin --merge` for the exact locally verified batch. Re-check `mergeable` and the tested source before merging; stop for conflicts, failed checks or denied approval. Keep the version bump in that same batch, not a separate PR. Do not change repository protection settings.
3. **Release notes.** One `docs/releases/v0.8.x.md` covers the batch. State which checks actually ran and whether packaging used GitHub or an explicitly requested local build. Do not describe an unbuilt or unpublished release as shipped.
4. **Test once for an explicitly requested local release.** On the exact integrated source, run the desktop Electron suite (`node --test desktop-electron/tests/*.test.cjs`) at low I/O priority, plus the release identity tests. Reuse valid passing evidence for unchanged inputs. A failure blocks release; fix it on the same batch branch and rerun the affected gate before merging. Do not create a new PR or full-suite run per task.
5. **Build like the release workflow.** Follow `.github/workflows/electron-windows-release.yml` on the exact merged commit, in `ct-build` (see step 5 above: reflog, running processes, low I/O priority, at least 3 GB free on G:):
   - `git submodule update --init`;
   - `bun install --frozen-lockfile` in `runtime-web`, `runtime-web/launcher` and `desktop-electron`;
   - the checksum-pinned tunnel-client archive the workflow names;
   - `cargo build --release --locked` for `rust-core/coding-tools-headless`;
   - `bun run --cwd desktop-electron package:win`.

   Then check what the workflow checks: `Coding.Tools_<ver>_win_x64_portable.zip`, `_update.json`, `*.ctpack` and `SHA256SUMS.txt` exist; delete `*.blockmap`; append the `.exe` hash to `SHA256SUMS.txt`; and `sha256sum -c SHA256SUMS.txt` passes.
6. **Publish by hand, draft first.** The in-app updater skips drafts.
   - `gh release create v<ver> --target <merged commit> --draft --title "Coding Tools v<ver>" --notes-file docs/releases/v<ver>.md <artifacts>/*`
   - Read it back without a second copy on disk: stream each asset with `gh release download v<ver> --pattern <file> -O - | sha256sum` and compare it with `SHA256SUMS.txt`.
   - Only then run `gh release edit v<ver> --draft=false --latest`.
7. **Clean up.** Delete the build's dated `aiTemp/Trash` folders in `ct-build`. Tell the user the release was built and tested locally, not by CI.

## Delivery fallback when PRs or Actions are unavailable

- **Standing user authorization (2026-11-07):** if PR creation, normal PR merge or GitHub Actions is unavailable, complete local verification, merge the scoped change into the user's GitHub repository and publish a new version instead of stopping solely for those unavailable services. This overrides the normal PR/CI-only route above. Packaging is the exception: the installer is built on GitHub (user rule, 2026-11-14). While Actions is disabled, the release waits for the user to re-enable it. A local build happens only when the user asks for it.
- Prefer an existing PR. If its merge is blocked solely by unavailable required CI, an administrator merge of the exact tested commit is authorized without changing repository protection settings. If PR creation itself is unavailable, use a normal non-force push of the verified, integrated commit to `main` only when the remote permits it. Do not change branch-protection, bypass lists, authentication, billing or account settings. Do not force-push or overwrite concurrent work; a remote or tool permission denial remains a blocker.
- Run the applicable tests, type checks and graph checks against the pinned source, reusing valid evidence for unchanged inputs. Package verification belongs to the single release build; do not start local packaging without the user's explicit request. Do not skip an actually failing check, invent a passing CI status or substitute an older build that omits the change. State explicitly that CI was unavailable and report the local verification used instead.
- Coordinate one release owner. GitHub's release workflow packages the new version from the exact merged source. When the user asks for a local build instead, build it with `bun run package:win`, at low priority with storage on G:, verify the installer, source provenance, downloadable assets and checksums, then publish through GitHub Releases. Documentation-only changes do not require another identical installer. Do not install, patch or restart the running app without the user's separate request.

## xyTom 0.3 integration invariants

- `old/` is a lossless source snapshot pinned by `old/UPSTREAM_SNAPSHOT.md` to `xyTom/coding-tools-mcp` 0.3.0. Never delete prior snapshot files: move replaced or upstream-removed content under `old/Trash/` and use `aiTemp/` for synchronization/build artifacts.
- When MCP `_meta.openai/session` is present, the first non-history tool call automatically creates or resumes the matching `docs/history-session/` archive. Explicit `history_session_bootstrap` remains the path for clients without metadata and for verbatim `initial_user_input` capture. Per-turn `history_session_checkpoint` is still required.
- Every shared `call_tool` result must carry bounded, path-aware `project_instructions`. Resolve the primary workspace and each approved `@alias` linked project as separate scopes; recognize case-insensitive `AGENTS.md`, `agent.md`, and `CLAUDE.md`; never load instructions from unapproved external paths.
- `command_id`, `kill_command`, and `command:<id>:stdout|stderr` are canonical. Preserve the existing `session_id`, `kill_session`, and `session:<id>:...` aliases until an explicit breaking release. Completed output must remain readable for the documented bounded retention window.
- Before merging this integration, run the Rust test/clippy/fmt suite, the Svelte check/build and Node tests.
