# Original Paseo, Anneal, and CommandCode Proxy panels

This change keeps the 0.7 Electron surfaces, but stops treating the three apps as redesigned shells.

## What changed

- **Paseo** iframe now opens real Expo routes from getpaseo/paseo `1e4ba65` (`/sessions`, `/open-project`, `/settings`). The original UI auto-embeds when `http://127.0.0.1:6768/` is ready and fills the panel.
- **Anneal** iframe now uses the original hash router (`#/tasks`, `#/projects`, …). Auto-embed when `http://127.0.0.1:3000/` is ready.
- **commandcode-proxy** (zahidhussaina2l @ `c123a3e`, default `http://127.0.0.1:9090/`) has no HTML dashboard. Integrations now shows the original CLI banner plus working Check / Start / Stop / Restart and copyable OpenAI / Anthropic base URLs. Inspect also reads `GET /` health.

CPA Provider Hub, Codex Router exclusive fields, the main sidebar, and the extension HUD are unchanged.

## Windows / remote Anneal

Anneal upstream is macOS/Linux, not native Windows. If the API already runs on another machine:

```bash
ssh -N -L 127.0.0.1:3000:127.0.0.1:3000 user@anneal-host
```

Point Coding Tools at `http://127.0.0.1:3000/`. The original board works as soon as that loopback service answers.

## How to verify

From `desktop-electron`:

```bash
node --test tests/original-upstream-panels.test.cjs tests/upstream-tools.test.cjs tests/rc7-full-integration-contract.test.cjs tests/external-services-control-plane.test.cjs tests/rc9-five-stack-completion.test.cjs
```

Manual:

1. Open **Paseo**. If the daemon is up, the original session UI should appear without clicking a decorative Open button. Session / settings tabs must not 404.
2. Open **Anneal**. The original task board should be `#/tasks`. On Windows without a local API, use the port-forward note, then Check / Start.
3. Open **Integrations → CommandCode Proxy**. The banner should list Cursor `.../v1` and `ANTHROPIC_BASE_URL`. Check fills health/models. Start / Stop call the managed loopback proxy, not a stub.

CommandCode chat completions remain client traffic to the proxy. This panel does not invent a second chat UI.

## PR #224 on LOL #221

This lane now stacks on `cursor/desktop-ui-ipc-proxy-fix-dc79`. Shared `app-handler/handler-registry.cjs` and `app-handler/host.cjs` stay on #221. CommandCode / Paseo / Anneal in-tree source lives under `app-handler/<app>/source/`. Repo-root `modules/` is a temporary re-export shim. Product calls remain in-process `codingTools.apps`; visuals stay inside the Coding Tools GUI.
