# Source integrations

`agent-orchestrator/` is a Git checkout of
https://github.com/Untrivial-ai/agent-orchestrator.

Develop the Coding Tools AO integration from this checkout. Do not install or
launch a separate AO desktop application. Keep generated build artifacts in the
project's `aiTemp/` directory and preserve upstream licenses.

The initial integration reference is commit
`73473d45f0c18f3a81f66f150868459e3098ca35`.

The Coding Tools changes to that checkout (embedded titlebar and sidebar, the
in-app terminal route, proxy-only shell terminal environment and the mission
board) are kept in `agent-orchestrator.coding-tools.patch`. To reproduce the
build input:

    git clone https://github.com/Untrivial-ai/agent-orchestrator.git module/agent-orchestrator
    git -C module/agent-orchestrator checkout 73473d45f0c18f3a81f66f150868459e3098ca35
    git -C module/agent-orchestrator apply ../agent-orchestrator.coding-tools.patch
