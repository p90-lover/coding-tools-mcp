# Coding Tools rc.9 Managed Five-Stack Integration Plan

## Goal

Make Codex Router, CPA/CLIProxyAPI Provider Hub, CommandCode Proxy, Paseo, and Anneal operable from inside Coding Tools without requiring the user to manually clone repositories, locate executables, or type launch commands.

Process isolation remains intentional: third-party services run as loopback-only child services, while Coding Tools owns installation, lifecycle, health, routing, encrypted credentials, and embedded UI. This avoids fusing unrelated runtimes into the Electron process while meeting the in-app management requirement.

## Exact base

- Repository: `p90-lover/coding-tools-mcp`
- Base branch: `release/codex-router-multiprovider-0.7.0-rc.8`
- Base SHA: `5aa516e35e8f9824d3309a4016f3f309f33d956c`
- Work branch: `integration/v0.7.0-rc.9-managed-five-stack`

## Defects in rc.8

1. Codex Router has a control plane but no in-app pinned installer; a user must supply a router executable.
2. CommandCode OAuth/session import exists, but the proxy process must already be installed and running.
3. Paseo can be embedded only after a source checkout and launch command are configured manually.
4. Anneal launches only `dev:web`; its required PostgreSQL, API, runner, setup, build, and migration lifecycle is not managed.
5. The Integrations page exposes raw executable fields before it exposes an install/repair lifecycle.

## Managed architecture

### Shared component manager

Add a main-process-only managed component manager that:

- reads pinned manifests shipped in `desktop-electron/vendor/managed-components/`;
- validates all component IDs, strategies, URLs, commits, SHA-256 values, commands, and loopback endpoints;
- stages downloads/checkouts under application `aiTemp/`;
- activates verified installs under application `components/`;
- moves superseded, partial, or mismatched installs under application `Trash/managed-components/`;
- never calls recursive deletion APIs;
- records an immutable install marker and a bounded install log;
- exposes inspect/install/repair through focused-window IPC;
- never returns provider secrets to the renderer.

### Codex Router

- Pin `duolahypercho/codex-router` v0.6.0.
- Windows x64 uses the published `model-router-0.6.0-windows-x64.exe` asset and its published SHA-256.
- Other platforms use pinned source or a platform release asset when declared.
- Configure Coding Tools to use the managed router CLI.
- Run integration through the existing supported `router integrate --apply` path.
- Health remains caller-key authenticated and loopback-only.

### CommandCode Proxy

- Pin `zahidhussaina2l/commandcode-proxy` commit `c123a3ebe017415ef45e619600a1110198dea7f8`.
- Clone to the managed component root.
- Launch with the packaged Node runtime or system Node and a main-process-only generated proxy API key.
- Reuse the existing CommandCode CLI-session import/OAuth account binding.
- Bind only to loopback and expose `/v1/models` health/model discovery.

### Paseo

- Pin `getpaseo/paseo` commit `1e4ba65c6d75a6b061a1d54141f2f105b5908a96` / v0.8.0.
- Run `npm ci`, `npm run build:server`, and launch `npm start` with `PASEO_LISTEN=127.0.0.1:6768`.
- Keep the dedicated execution WebSocket endpoint and embed every upstream section in the Paseo tab.

### Anneal

- Pin `mosonlab/anneal` commit `e43b72b10ad389f090a0be18eea5d2bcef468f5e` / v0.9.0.
- Native Linux/macOS lifecycle: `npm ci`, `setup:local`, `build`, PostgreSQL, migration, API, runner, and web.
- Windows lifecycle: managed WSL2 execution because upstream explicitly does not support native Windows.
- UI endpoint is `http://127.0.0.1:5173/`; API/execution endpoint is `http://127.0.0.1:3000/`.
- Start API, runner, and web as one supervised topology and stop PostgreSQL through the upstream compose project.

## Renderer behavior

The Integrations surface must show:

- installation state (`not installed`, `installing`, `installed`, `repair required`, `external`);
- pinned version/commit;
- Install / Repair button;
- Start / Stop / Restart / Health controls after installation;
- prerequisites with actionable diagnostics;
- advanced executable/home fields behind a disclosure instead of making them the primary path;
- English and Traditional Chinese copy.

## Test-first gates

1. RED contract proves rc.8 lacks managed manifests and install IPC.
2. Manifest parser/unit tests cover every strategy and reject remote listeners, unpinned sources, malformed hashes, path escape, and destructive commands.
3. Fixture installers prove staging, activation, repair, and Trash retention without network access.
4. External-service tests prove managed install results are applied to lifecycle configuration.
5. CommandCode tests prove proxy keys stay out of snapshots/logs.
6. Anneal tests prove PostgreSQL/API/runner/web topology and Windows WSL2 boundary.
7. Strict TypeScript and production renderer build pass.
8. Windows packaging includes every managed manifest and manager module.
9. Packaged launcher smoke verifies the install IPC contract without downloading or consuming provider quota.
10. No project path is deleted; transient output stays under `aiTemp/` or `Trash/`.

## Release boundary

No rc.9 tag or installer is published until the exact source head passes the Linux contracts and the authoritative Windows package, migration, packaged-launcher, checksum, provenance, and remote asset-readback gates. Live provider/OAuth acceptance remains a manual, no-quota CI boundary.
