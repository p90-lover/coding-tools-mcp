# Source integrations

`agent-orchestrator/` is a Git submodule pinned to the Coding Tools fork
https://github.com/p90-lover/agent-orchestrator (branch
`coding-tools/cpa-gateway`), which tracks upstream
https://github.com/Untrivial-ai/agent-orchestrator.

Develop the Coding Tools AO integration from this checkout. Do not install or
launch a separate AO desktop application. Keep generated build artifacts in the
project's `aiTemp/` directory and preserve upstream licenses.

The upstream base is commit `73473d45f0c18f3a81f66f150868459e3098ca35`. The fork
adds, on top of it:

- the per-session CPA gateway, so external harnesses can run any CPA model;
- the Coding Tools integration (embedded titlebar and sidebar, the in-app
  terminal route, the proxy-only shell terminal environment and the mission
  board).

The pinned commit is the complete build input, so a normal submodule checkout is
enough:

    git submodule update --init module/agent-orchestrator

`agent-orchestrator.coding-tools.patch` is the same integration as a patch
against the upstream base. It is kept for reference and is already part of the
pinned commit, so do not apply it to the submodule.
