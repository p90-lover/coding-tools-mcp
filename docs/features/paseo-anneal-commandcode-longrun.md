# Paseo, Anneal, and CommandCode Proxy — original function + 7-day live

This is a **focused follow-up on top of #192** (`0.7.0-rc.11` five-stack Start+health). It does **not** duplicate LOL's five-stack tree, CPA, Codex Router exclusive editors (`#190` remains Bot GG keep-alive SoT), or the Desktop shell-only lane.

Unique deltas #192 lacked:

- Electron Integrations **Check status / Copy plan / Apply non-secret** (never collects CommandCode `user_*`)
- CommandCode inspect **12s**, packaged **9090** with **3050** fallback, `HOST=127.0.0.1` on owned Start, **keepAlive ≠ autoStart**
- Paseo/Anneal **allowlisted original-function** RPCs/POSTs plus iframe auto-embed
- CommandCode OAuth/CLI **session revive** after crash
- Tauri lease/live/actions original-function (kept additive with #192's execution/provider/orchestrator stack)

## Inventory (current main vs originals)

| App | Original surface | Original functions used here | Gap on main before this change |
|---|---|---|---|
| **Paseo** getpaseo/paseo `da8c1b5` | Expo web: `/sessions`, `/open-project`, `/settings` (daemon WS `ws://127.0.0.1:6767/ws`, web often `http://127.0.0.1:6768`) | protocol v1 `send_agent_message_request`, `resume_agent_request`, `cancel_agent_request`, `archive_agent_request`, `agent_permission_response`, `create_agent_request` plus directory fetch | One-shot hello + `fetch_agents_request`; Sessions page explicitly sent nothing; invented paths were never used on this Svelte surface, but there was no original UI embed and no mutations |
| **Anneal** mosonlab/anneal `088f0d5` | Hash router `#/tasks`, `#/projects`, `#/inbox` at `http://127.0.0.1:3000/` | `POST /tasks/:id/start\|retry\|archive\|unarchive`, `POST /tasks/:id/chain/hold\|resume`, `GET /inbox/messages`, `POST /inbox/messages/:id/decision\|reply\|close` | `GET /tasks?view=board&archived=false` only; local twelve-stage board is a separate operator checklist |
| **CommandCode Proxy** MAXeaglet/commandcode-proxy | No HTML dashboard. CLI banner: version, listen, Cursor `/v1`, `ANTHROPIC_BASE_URL` | `GET /health`, `GET /v1/models`, Start/Stop of an owned loopback process, Codex Router generic-provider plan from #181 | Status was models GET only; no banner, no `/health`, no process control |

Not bundled: Paseo relay/voice/pairing, Anneal runner/scheduler/merge-executor, CommandCode upstream inference, `user_*` collection.

## Durability (7-day)

Keep-alive is a desktop-process supervisor, not a page timer. Dropped WS/HTTP reconnects with exponential backoff (1s→60s + jitter). A stable 120s stretch resets the counter. Paseo reuses the saved observer `clientId` and never auto-creates agents. After crash, `keep_alive` leases resume; missing credentials show an operator-visible reconnect-needed state. Snapshots older than 90s (Paseo live) or 120s (HTTP poll) are labelled **stale**.

Credentials stay in RAM unless Remember is checked (then `app_secrets["integration"]`). CommandCode `user_*` is never accepted.

## Verify

```bash
node scripts/check-control-center.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib control_center -- --test-threads=1
node --test desktop-electron/tests/commandcode-proxy-plan.test.cjs desktop-electron/tests/upstream-actions.test.cjs desktop-electron/tests/external-services-control-plane.test.cjs desktop-electron/tests/original-upstream-panels.test.cjs desktop-electron/tests/commandcode-provider-session.test.cjs
```

Manual (when the local services are already running):

1. Integrations → Paseo: Connect with keep-alive. Original `/sessions` UI should fill the panel. Send / Resume / Cancel / Allow must call the daemon; they are not decorative.
2. Anneal: Original board at `#/tasks`. On Windows without a native API: `ssh -N -L 3000:127.0.0.1:3000 user@host`, then Connect. Start/hold/inbox decision hit the allowlisted POST paths.
3. CommandCode Proxy: banner lists Cursor `…/v1` and `ANTHROPIC_BASE_URL`. Check hits `/health` and models. Start/Stop only manage an owned `HOST=127.0.0.1` child. Copy plan still includes `credential … set` and never asks for a key.
4. Unplug the service: status becomes reconnecting then stale, without log/UI spam. Restart Coding Tools with keep-alive still on: it resumes without creating a new Paseo agent.

The desktop WebView is not driven in this environment; contract tests cover adapter boundaries, backoff, and allowlisted RPCs.
