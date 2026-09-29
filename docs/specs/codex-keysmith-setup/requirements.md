# Optional Codex Keysmith setup

Date: 2026-09-29. Scope: normal, non-DEV Coding Tools on Windows.

## 功能概述 / Purpose

Add **Codex Keysmith** as optional Setup step 4. A user can inspect Keysmith status, select their own Markdown instructions, review Keysmith's planned changes, and explicitly apply or remove them from Coding Tools. The first three setup checks, native Codex models, Web GPT bridge, and MCP work independently of this step.

## Historical evidence and terms

- The verified upstream is `Jia-Ethan/codex-keysmith` v0.6.0, MIT. The exact release script SHA-256 is `837ec25713851a2fb6d8646dd078ee03a2e23fe17b19e97e093cedb02349979d`.
- Upstream's default instruction is not selected. `--file` selects custom Markdown and `--skip-hooks-isolation` retains existing hooks when `--codex-dir` is explicit.
- **Codex home** is the resolved existing `CODEX_HOME` or Codex default, never a hard-coded project directory.
- **Dry run** means invoking Keysmith with `--dry-run`; it changes no Codex config or hooks. **Apply** means the user approved the exact preview and the installer runs with `--yes`.

## 范围边界 / Scope

In scope: pinned script in the desktop package, read-only status, user-selected Markdown, dry-run preview, deliberate apply, verification, and reversible uninstall through upstream Keysmith. Clear readiness and errors in the Setup UI.

Out of scope: installing the upstream bundled refusal-override prompt, changing or isolating existing Codex hooks, silently modifying global Codex config, replacing model providers, creating accounts/API keys, changing proxy/MCP settings, or requiring Keysmith for the first three setup checks.

## 需求列表 / Requirements

### FR-1: Optional Setup row

Priority: Must. As the owner, I can find Keysmith after the existing checks without losing Codex or Web GPT setup.

- WHEN Setup opens in automatic mode, it SHALL show a numbered fourth Keysmith row marked optional, after Install into Codex.
- WHEN Keysmith is absent, unavailable, or fails, the first three steps, `coreSetupComplete`, catalog verification, and MCP readiness SHALL retain their existing results.
- WHEN manual interaction hides the first two checks, the Keysmith entry SHALL still be identifiable as optional without renumbering existing semantics incorrectly.

### FR-2: Verified runner and status

Priority: Must. As the owner, I can see whether the pinned Keysmith runtime and Python work on this computer.

- WHEN Keysmith status is requested, the app SHALL use an exact bundled, checksum-verified v0.6.0 script and the resolved Codex home.
- IF Python 3.10+ or the bundled script is unavailable, it SHALL show a specific actionable status and SHALL not claim Keysmith is installed.
- Status SHALL never execute an install or change Codex configuration.

### FR-3: Custom instructions and preview

Priority: Must. As the owner, I can choose and inspect the Markdown that would be installed.

- WHEN I select a local Markdown file, the UI SHALL show its path, bounded content, and the resolved Codex home without copying the file into a chat or log.
- The dry run SHALL use `--codex-dir`, `--file`, `--skip-hooks-isolation`, and `--dry-run` together. No path may omit the custom file or hook-preservation flag.
- IF the source file or target Codex home changes between preview and apply, the app SHALL require a new preview.
- Existing `model_instructions_file`, provider routes, MCP entries, and hooks SHALL be preserved by the preview; the app SHALL state the planned global instruction change before applying.

### FR-4: Confirmed apply and recovery

Priority: Must. As the owner, I can apply or remove the selected instructions deliberately.

- BEFORE apply, an app-owned confirmation SHALL identify the selected file, Codex home, upstream version, and the setting that changes; Cancel is the default.
- ONLY a confirmed operation SHALL invoke Keysmith with `--yes`, always with `--file` and `--skip-hooks-isolation`. The runner SHALL use argument arrays with no shell expansion.
- WHEN apply completes, the app SHALL check Keysmith status again and report the actual result, including that new Codex chats use the instruction while active chats keep their current context.
- Removal SHALL first show a preview of the upstream uninstall and require a separate confirmation, then verify restoration. It SHALL not invoke hook restoration because this integration never isolated hooks.
- IF a command times out or fails, the UI SHALL report an uncertain or failed result rather than blindly retrying the write.

## 非功能需求 / Nonfunctional requirements

- **NFR-1:** Keep CLI output bounded; never log Markdown contents, Codex config contents, tokens, or credentials. Show only safe status and explicit preview text to the local user.
- **NFR-2:** Preserve exact upstream release bytes and license in the package. Do not fetch and run mutable remote code at startup or during install.
- **NFR-3:** Validate selected file type/size and Codex home paths; prevent untrusted renderers and background content from calling mutation IPC.
- **NFR-4:** Keep existing dark Setup typography, focus treatment, keyboard operation, and narrow window behavior.
- **NFR-5:** Verify with isolated test Codex homes before checking installed non-DEV Coding Tools. Do not alter the real Codex home during automated tests.

## 依赖关系 / Dependencies

Installed Python 3.10+, the bundled verified v0.6.0 script, Coding Tools' trusted main-window IPC, existing Codex home resolution, and the current Setup component.

## Acceptance state

- [x] User asked for optional Step 4 and said to continue implementation.
- [x] Upstream custom-file/hook-preserving mode and script checksum verified.
- [ ] Product code, focused regression checks, installed GUI, and real optional-step status verified.
