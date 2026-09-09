# AI + human workflow and learning guide

**English** · [繁體中文](ai-human-workflow.zh-Hant.md) · [Product README](../../README.en.md)

This guide describes the `v0.4.1-rc.1` workflow. It is an operating method, not a claim that the app runs an autonomous engineering team or trains a model. Use the actual published release evidence to establish what was tested.

## The three roles

The **human** owns the goal, authorized scope, acceptance criteria and release decision. The **AI client** reads context, proposes changes, chooses available tools and explains results. **Coding Tools MCP** provides deterministic local execution, permission checks, tool results and project-history mechanisms. The app does not launch a hidden Codex reasoning loop or another AI reviewer.

```text
Human goal + constraints
  → project instructions + bounded history
  → small plan + acceptance checks
  → live-policy authorization
  → local file / command / image / computer tool
  → actual result and evidence
  → human review / correction
  → verified checkpoint and lesson
  → explicitly approved delivery
```

There are two feedback paths. A failed check returns to inspection and a revised hypothesis. An unclear requirement returns to the human, not to a guessed implementation. An uncertain input outcome returns to observation: never replay a submitted click, command or external action merely because a response timed out.

## 1. Define success before acting

Example task: “Allow permission changes without restarting or relinking MCP. Keep screenshots in RAM. Preserve files. Do not invoke Codex inference. Return a Windows installer.”

A useful acceptance contract is: the same listener and credentials remain usable; a write is denied under read-only and allowed after a local policy change; old grants cannot authorize new actions; screenshot permission revocation discards an in-flight frame; source identity, installer version and checksums match. These are conditions to verify, not assumptions.

Agree on protected files, allowed directories, whether commands may contact the network, and which operations require a separate human decision. Put temporary work in `aiTemp/`; preserve unwanted files under `Trash/`. The app's `policy_only` command executor is not a universal OS sandbox or deletion interceptor.

## 2. Restore context without loading the entire past

Start with `server_info`, `codex_tools_status` and project instructions. Use `history_session_bootstrap` with the user's verbatim `initial_user_input` when an exact starting request needs preserving. Keep its returned `session_key` and `current_path`.

When the client supplies `_meta.openai/session`, the server can automatically create or restore the matching bounded archive for ordinary calls. That does not give the server access to messages the client never supplied. Find earlier details with `history_session_search`, then page through `history_session_read` using its returned cursor and expected hash. Do not invent missing history or treat an old “passed” report as current evidence.

## 3. Keep the plan small and explicit

For a short working plan, call `get_plan`, then use its revision in `update_plan`:

```json
{
  "expected_revision": 0,
  "explanation": "Reproduce first, then change the permission path.",
  "plan": [
    {"step": "Reproduce the current behavior", "status": "in_progress"},
    {"step": "Make the smallest scoped change", "status": "pending"},
    {"step": "Verify and review the result", "status": "pending"}
  ]
}
```

Replace `0` with the real revision returned by `get_plan`. At most one step may be in progress. This plan lives in the listener's memory, is shared within that listener, and disappears when it exits. It does not execute tasks. Use project Markdown/history or the local board for a durable reviewed record.

The board's twelve stages are Specification, Plan, Plan review, Revise plan, Implementation, Code review, Independent review, Apply fixes, Documentation, Verification, Merge readiness and Delivery. A recorded stage is an operator assertion supported by a note; it is not proof that a reviewer or test ran. “Independent review” must not be attributed to an AI reviewer that was never invoked.

## 4. Inspect, act, then verify

Prefer structured interfaces. Read/search code before modifying it; use Git inspection and patch preflight where available. For desktop work, prefer a known application capability or UI Automation selector before coordinate-based input. Use a fresh snapshot and exact target identity when coordinates are required.

Background **observation** is different from background **input**. Approved supported windows can be observed without activation; real Windows mouse/keyboard input still needs the selected foreground target. “Always enabled” means the local grant has no countdown, not that all windows are approved or screenshots are continuously uploaded. Keep Pause/Stop visible.

Select only the checks that address the changed risk. For the permission example, the high-value checks are one authenticated same-listener request flow, authorization/revocation behavior, and the packaged installer identity. A computer-control change additionally needs the isolated real Windows input/capture fixture. Preserve the actual result, including failures; an optimistic summary is not evidence.

## 5. Review as a learning exercise

Before execution, have the human predict the expected result and explain why. Have the AI identify the assumption it is testing, the smallest relevant check, and what would disprove its hypothesis. After execution, compare prediction with observation and explain the difference.

Use a review question such as: “Show the changed boundary, what behavior is preserved, and what remains untested.” Ask for source and test evidence, not private model reasoning. The human should reject a change they cannot explain well enough to maintain. The AI should revise its proposal when evidence contradicts it, not rename failure as success.

A compact lesson template:

```markdown
## Lesson: <specific reusable topic>
Context and scope:
Observed symptom:
Initial hypothesis:
Expected result:
Check performed and exact environment:
Actual result / evidence reference:
Rejected explanation:
Confirmed cause or remaining uncertainty:
Smallest correction:
Regression risk and follow-up check:
Human review decision and reason:
Reusable rule, with its limits:
```

Do not include secrets, authentication headers, full private transcripts or screenshots. Link to a non-sensitive evidence record instead. Use explicit “observed,” “inferred,” and “not verified” labels.

## 6. Save the handoff and authorize delivery

At the end of the task, call `history_session_checkpoint` using the saved `session_key`, pass the returned `current_path` as `expected_path`, and include the user's exact request as `raw_user_input`. Confirm `ok=true` and the matching target before reporting that the checkpoint was saved. A new chat should resume that target, not start an unrelated archive.

The release decision must separate source committed, checks passed, installer built, package inspected, assets uploaded, release published and main updated. Do not call all seven complete based on only a commit or a running CI job. A useful handoff reports the exact source commit, changed behavior, checks actually run, remaining gaps and the real artifact link.

## What “learning” means here

**Human learning:** comparing predictions with outcomes and explaining reviewed changes can expose gaps in understanding. **AI task adaptation:** approved notes and project instructions can be retrieved as context in a later session. **Not implemented:** automatic updates to model weights, fine-tuning, global cross-account memory, or training on your screenshots. The local plan, board and history have different lifetimes and should not be conflated.

The intended workflow improvements are fewer repeated explanations, explicit uncertainty, smaller diffs and easier handoff. They are design goals, not benchmark claims. Measure repeated regressions, review rework, unknown-outcome retries and time spent rebuilding context. Review stale lessons before turning them into permanent project rules; a rule that solved one application may not apply to another.

## Tool and integration limits

Use `tool_search` and `codex_tools_status` rather than assuming every Codex internal handler is available. Local shell/file/patch/plan/image counterparts do not imply Codex subagents, context-window management, cloud search or account/plugin APIs. Chat questions stay in the AI client. The native command sandbox is withheld; ordinary commands remain `policy_only`.

Paseo/Anneal adapters observe existing local services. Their full voice/mobile, scheduling, agent-review and autonomous-merge engines are not bundled or launched. An external service can independently spend its provider quota. This application's local tools and this release workflow do not invoke Codex inference.

## Source and further reading

Implementation: [live policy](../../src-tauri/src/tools/live_policy.rs), [local tool handlers](../../src-tauri/src/tools/local_tools.rs), [shared dispatcher](../../src-tauri/src/tools/dispatch.rs), [history](../../src-tauri/src/tools/history), [operator board](../../src-tauri/src/integrations/board.rs), [release workflow](../../.github/workflows/live-permissions-release.yml).

Client-side setup and approval rules: [OpenAI developer-mode guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta). These are separate from the desktop application's live permissions.

## Optional native-session review candidate

The [native Codex bridge](../features/native-codex-runtime.md) adds a separate locally approved provider path. The earlier v0.4.1 model-free description still applies to local tools, not to an enabled native session. Define the review scope and spending tolerance, enable the specific listener, submit a bounded review task, inspect actual turn completion, and verify the explanation against code and a relevant check. Native `compact` is context compaction, not training or model-weight changes. A fixture does not prove a paid/authenticated review ran. Human corrections should become reviewed notes, not silently trusted instructions. Stop/revocation prevents new bridge submissions but cannot undo effects already submitted to the native runtime or provider.
