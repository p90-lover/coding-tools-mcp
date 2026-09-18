# CommandCode Proxy on the control center

This is a surgical addition on the 0.4.11 Svelte/Tauri Integrations page. It does not merge the 0.7 Electron stack.

## What it does

- Ports the 0.7 Codex Router generic-provider registration plan (`commandCodeProxyRegistrationPlan` / `renderCommandCodeProxyPlan`).
- Checks loopback-only HTTP status with `GET …/v1/models` (no Authorization header, no `user_*` collection).
- Copy / dry-run the registration plan in the UI. Apply runs add, enable and curate only if `model-router` and `curate-models` are installed.
- Leaves Paseo and Anneal as working read-only Connect/snapshot adapters via `integration_read`.

## Defaults

- Registration base URL: `http://127.0.0.1:3050/v1` (same as the 0.7 provider script).
- Alternate listen often used by the upstream proxy: `http://127.0.0.1:9090/`.
- Upstream package: `MAXeaglet/commandcode-proxy`.

## Verify

```bash
node scripts/check-control-center.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib control_center -- --test-threads=1
```

Open Integrations in the desktop app. Paseo/Anneal Connect & read is unchanged. CommandCode Proxy Check status against a loopback URL; Copy plan must include `credential … set` and must not ask for a key. Anneal includes a copyable `ssh -N -L 3000:127.0.0.1:3000 user@host` hint for Windows port-forward setups.

The desktop WebView was not driven in this environment; contract tests cover the plan and adapter boundaries.
