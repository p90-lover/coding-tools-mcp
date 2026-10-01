# AO integration verification, 2026-09-27

## Latest installed verification

This update supersedes the earlier Runtime display and signed-out findings below.

- Runtime > Agent Orchestrator now opens the upstream `SessionsBoard`, using the selected project's `/projects/<id>` board or `/sessions/` before a project is selected. More retains the original AO application. Existing Coding Tools plan records were not deleted or silently imported.
- Authenticated requests from the embedded original AO UI run without the redundant per-POST Coding Tools approval dialog. The real display-readiness POST returned HTTP 200 without a prompt. Session cookies, same-origin checks, loopback binding, remote-access rejection, named handler checks, and harness tool permissions remain enforced.
- TypeScript and production renderer builds passed. The focused AO regression suite passed with 39 tests, including project-board navigation and automatic readiness. Packaged UI navigation and installed UI navigation passed; leaving AO for Settings detached its native view.
- Verified package: `aiTemp/ao-automatic-project-board-20260927/output/win-unpacked`. Only the renderer and two AO host modules changed in its app archive. The installed executable and app archive matched this package after restart.
- The runtime did not recognize ChatGPT's current accessible textbox. Added the existing desktop selector to the shared runtime selector; the session and browser-worker tests passed. The two generated runtime entrypoints received the same bounded selector replacement, retaining all other bundled code. Runtime bundle `335954ce7818fc57b9681c625fb45979ae4be91291b727c5813a70192044dec5` validates in both the installed resources and active version directory.
- Live `/v1/session/inspect` subsequently returned `authenticated: true` and `temporary: true`. The visible ChatGPT surface has a composer, with no login or challenge prompt. QA attaches with `noDefaults: true` to preserve Electron-owned browser settings.
- The live CPA catalog still contains `gemini-3.8-flash-high`. A completed WebGPT > Gemini > WebGPT mission receipt is still outstanding; session and catalog checks do not satisfy that acceptance test.
- Program rollback pair: `aiTemp/Trash/ao-auto-project-board-20260927-014033`. Prior runtime files and package manifest: `aiTemp/Trash/webgpt-composer-20260927-020602/runtime`. Existing app data and prior backups remain intact.

## Installed result

- Source checkout: `module/agent-orchestrator`, pinned to `73473d45f0c18f3a81f66f150868459e3098ca35` with local integration changes.
- Standalone AO application: not installed. The original renderer and compiled Go daemon are resources of Coding Tools.
- Installed application: `C:\Users\simon\AppData\Local\Programs\Coding Tools\Coding Tools.exe`.
- Verified staged payload: `aiTemp/ao-source-package-20260927-verified/win-unpacked`.
- Rollback program copy: `D:\CodingToolsRecoverable\Trash\CodingTools-before-source-AO-20260927-0207`.
- Prior backups and persistent user data were not deleted. The executable, main ASAR, Rust headless binary, and new AO daemon matched the staged files by SHA-256 after installation.

## Verification performed

- Host `npm run build`: preload build, TypeScript check, and Vite renderer build passed.
- Actual upstream production renderer built from the source checkout with preview fixtures disabled. Renderer-only registry dependencies avoid the unused Electron Forge Git dependency blocked by npm policy.
- Actual upstream Go daemon built with the immutable `CodingToolsLocalOnly=1` build setting.
- `go test ./internal/httpd -run TestCodingToolsCannotEnableLAN -count=1 -v`: passed.
- Focused Node suite: 38 tests passed across lifecycle, upstream gateway/handler, mission workflow, browser gateway, and retired package boundaries.
- Independent review found startup/stop races, stale recovery/view state, stalled-request cleanup, and stale status reporting. Fixes and targeted regression coverage were applied.
- Native Electron smoke rendered the original Add a project screen against the actual daemon. A direct mobile-enable request returned HTTP 403.
- Packaged host UI test opened Runtime > Agent Orchestrator and More > Agent Orchestrator, then verified that navigation detached the native original view.
- OS socket inspection found the AO daemon and gateway bound only to `127.0.0.1`.
- Package verification passed with no detected secrets and the expected existing runtime bundle ID `f90318cffa9eedf78f620a29aff4c608302090b0cf473aa09291f9a350a183ce`.
- Installed app was reopened from its normal path. Both installed panels were exercised and screenshots saved as `aiTemp/ao-installed-missions.png` and `aiTemp/ao-installed-original.png`.

## Handler API

The existing `codingTools.apps.call` registry exposes `moduleId: agent-orchestrator` with named operations:

- `upstream_status`, `upstream_projects`, `upstream_sessions`, `upstream_agents`, `upstream_orchestrators`.
- `upstream_start`, `upstream_stop`, `upstream_show`, `upstream_hide`, `upstream_bounds`.
- `upstream_create_project`, `upstream_create_session`, `upstream_create_orchestrator`, `upstream_send`.

No arbitrary upstream URL operation is exposed. Mutations retain local confirmation. Only trusted main-renderer layout calls (`upstream_hide` and `upstream_bounds`) may proceed without keyboard focus; these cannot start execution or change model consent. Original and mission execution retain separate durable state rather than silently migrating existing missions.

## Outstanding acceptance checks

The requested live WebGPT-orchestrator / Gemini-worker mission is BLOCKED. The installed app snapshot reports `authenticated: false` and `browserStatus: signed-out`. CPA's live catalog includes `gemini-3.8-flash-high`; no replacement model was selected. Sign in through Coding Tools > Browser before resuming FR-5. No end-to-end model execution receipt is claimed.

Broad keyboard, narrow-window, long-name, and theme-state QA remains beyond the completed navigation/layout smoke. Existing unrelated legacy suites were not treated as green, and the complete Rust/Svelte/Python merge gate was not run for this Electron-only integration.

The first isolated package startup encountered an existing Windows EPERM error while atomically renaming a newly copied runtime directory. The succeeding startup check pre-materialized and validated the exact runtime in isolated state. This verifies packaged startup and this update path, not a fresh installer atomic-rename path.

Windows occlusion initially marked the test view hidden. Only smoke launch arguments disabled occlusion tracking; the installed application was launched normally. The integration is installed and usable, but the delegated feature must remain blocked until the live mission and remaining acceptance checks are completed.
