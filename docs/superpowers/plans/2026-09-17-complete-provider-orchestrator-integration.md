# Complete Provider and Orchestrator Integration Plan

> **Execution rule:** preserve all existing source and evidence; temporary material belongs under `aiTemp/`, and superseded files move to `aiTemp/Trash/` rather than being deleted.

**Goal:** make the active Electron application use one main-process provider/account/router boundary for CPA-style multi-account management, Codex Router, CommandCode Proxy, browser-backed Codex/ChatGPT accounts, subagents, Paseo, and Anneal, while reporting unsupported upstream-runtime prerequisites honestly.

**Architecture:** retain the Electron/React shell and encrypted Provider Network store. Bind the Provider Network controller to the live `BrowserHost`, extend the execution planner to subagent workloads, expose one integration-readiness snapshot, and make upstream-tool startup resolve a managed or operator-supplied pinned checkout instead of silently presenting a facade as a bundled runtime. Paseo and Anneal continue through allowlisted loopback adapters; secrets remain in the Electron main process.

---

## Task 1: Record the missing integration contracts

**Files**
- Create: `desktop-electron/tests/complete-provider-orchestrator-integration.test.cjs`
- Create: `.github/workflows/rc8-complete-provider-orchestrator-integration.yml`

**Contracts**
1. Codex OAuth and ChatGPT Web login must use the live BrowserHost and fail closed when it is unavailable.
2. Codex Router must plan `subagent`, `paseo`, and `anneal` workloads through the same provider/account/model/proxy policy.
3. CommandCode Proxy must retain OAuth, CLI import, probing, model discovery, and encrypted secret handling.
4. Paseo and Anneal must expose honest managed-runtime state and never claim a missing external runtime is bundled.
5. The active Provider Center must expose the complete provider catalogue and CPA-style account lifecycle.

Run the focused workflow and retain the initial failing evidence.

## Task 2: Bind browser-backed provider accounts

**Files**
- Modify: `desktop-electron/electron/provider-bootstrap.cjs`
- Modify: `desktop-electron/electron/provider-network.cjs`
- Modify: `desktop-electron/electron/main.cjs`
- Modify: `desktop-electron/electron/main-with-provider.cjs`
- Test: `desktop-electron/tests/complete-provider-orchestrator-integration.test.cjs`

**Implementation**
- Add an explicit browser-host resolver registration API.
- Register the live BrowserHost from `main.cjs` after construction.
- Make browser provider login fail closed when no BrowserHost exists.
- Synchronize Codex OAuth / ChatGPT Web account health from the authenticated browser snapshot without exposing session cookies or tokens.

## Task 3: Use Codex Router for subagents

**Files**
- Modify: `desktop-electron/electron/provider-execution-router.cjs`
- Modify: `desktop-electron/src/providers/provider-types.ts`
- Modify: `desktop-electron/src/types.ts`
- Modify: `desktop-electron/src/agents/agent-provider-adapter.ts`
- Test: `desktop-electron/tests/complete-provider-orchestrator-integration.test.cjs`

**Implementation**
- Add `subagent` as an execution workload and proxy scope.
- Add provider capability flags for subagents.
- Replace static-only model-provider compatibility with an ID-based execution-plan request through the main-process router.

## Task 4: Make Paseo and Anneal runtime state honest and manageable

**Files**
- Modify: `desktop-electron/electron/upstream-tools.cjs`
- Modify: `desktop-electron/vendor/upstream/paseo.json`
- Modify: `desktop-electron/vendor/upstream/anneal.json`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/types.ts`
- Modify: `desktop-electron/src/features/UpstreamToolSurface.tsx`
- Test: `desktop-electron/tests/complete-provider-orchestrator-integration.test.cjs`

**Implementation**
- Resolve an operator checkout, a managed checkout, or a packaged runtime explicitly.
- Validate pinned repository/commit metadata and license before launch.
- Expose runtime mode (`packaged`, `managed`, `external`, `unavailable`) and prerequisites.
- Keep loopback-only endpoint enforcement.
- Do not claim Anneal is natively supported on Windows; expose its Docker/Linux prerequisite and preserve the adapter for a reachable service.

## Task 5: Add a single readiness contract

**Files**
- Modify: `desktop-electron/electron/provider-bootstrap.cjs`
- Modify: `desktop-electron/electron/preload.cjs`
- Modify: `desktop-electron/src/types.ts`
- Modify: `desktop-electron/src/features/ProviderHubSaasSurface.tsx`
- Test: `desktop-electron/tests/complete-provider-orchestrator-integration.test.cjs`

**Implementation**
- Return readiness for Provider Hub, router workloads, browser bridge, CommandCode, Paseo, and Anneal.
- Surface blocking reasons in the GUI rather than silently enabling actions.

## Task 6: Verify and release

Run only the focused high-value gates:

```text
node --test desktop-electron/tests/complete-provider-orchestrator-integration.test.cjs
node --test desktop-electron/tests/provider-execution-router.test.cjs desktop-electron/tests/commandcode-provider-session.test.cjs desktop-electron/tests/rc7-full-integration-contract.test.cjs
bun run --cwd desktop-electron typecheck
bun run --cwd desktop-electron build:renderer
```

Then run the Windows package smoke and exact-source release workflow. Do not merge or publish until the exact branch head passes.