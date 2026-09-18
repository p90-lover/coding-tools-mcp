# CommandCode Proxy on the control center

Integrations hosts the original CommandCode CLI banner and managed Check/Start/Stop/Restart on `127.0.0.1:9090`, plus the Codex Router generic-provider registration plan. Coding Tools never collects the `user_*` key.

## What it does

- Original banner UI (`CommandCode AI Proxy`, OpenAI/Anthropic base URLs, `app-managed (not shown)`).
- Managed lifecycle through `five_stack_start` / `stop` / `restart`, with health `GET /` and `GET /v1/models`.
- Ports the Codex Router generic-provider registration plan (`commandCodeProxyRegistrationPlan` / `renderCommandCodeProxyPlan`).
- Copy / dry-run the registration plan in the UI. Apply runs add, enable and curate only if `model-router` and `curate-models` are installed.
- Paseo and Anneal original UIs are managed on `127.0.0.1:6768` and `127.0.0.1:5173`. Observation snapshots stay read-only.

## Defaults

- Managed listen: `http://127.0.0.1:9090/`.
- Registration base URL: `http://127.0.0.1:3050/v1` (same as the 0.7 provider script).
- Upstream package: `zahidhussaina2l/commandcode-proxy` (pinned) / `MAXeaglet/commandcode-proxy`.

## Verify

```bash
node scripts/check-control-center.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib -- five_stack commandcode -- --test-threads=1
```

Open Integrations. Use Install and start all, then open each original UI. CommandCode Copy plan must include `credential … set` and must not ask for a key. Anneal has no user SSH port-forward.
