# Tasks: CPA Accounts integration

## 任务列表
- [ ] Confirm exact CPA auth-section name, plugin ABI, Windows artifact, and CommandCode CLI account format.
- [ ] Change Runtime navigation to Accounts with embedded CPA Auth Files; remove API Models and Codex Router navigation.
- [ ] Enable CPA plugins using a persistent absolute directory without changing keys or auth files.
- [ ] Install Go-plan and Studio CommandCode CPA plugins and expose working login choices in CPA OAuth Login.
- [ ] Verify both plugins' registration, OAuth login, models, and local requests.
- [ ] Remove Codex Router backend, active module wiring, route selection, and package inputs; route surviving Codex OAuth traffic through CPA and preserve state migration.
- [ ] Move local CommandCode module and bundled source to Trash after successful CPA verification.
- [ ] Run focused tests and frontend build; review diff and report any live-runtime limits.

## 交付物清单
- Desktop navigation and login wiring.
- Managed CPA plugin configuration and installed Windows plugin.
- Recoverable archive of retired module code.
- Focused test and runtime evidence.

## 需求覆盖矩阵

| Requirement | Tasks |
| --- | --- |
| FR-1, FR-6 | Navigation and legacy route task |
| FR-2 | CPA config task |
| FR-3, FR-4 | Plugin install, login and live verification tasks |
| FR-5 | Codex Router and local module retirement tasks |

## 文件变更清单

- `desktop-electron/src/App.tsx` and CPA embedding component
- `desktop-electron/electron/cpa-managed.cjs` and account login bridge
- Managed component manifests, module registry and packaging references
- Focused tests in `desktop-electron/tests/`
