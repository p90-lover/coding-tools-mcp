# Tasks

## 交付物清单
Native plugin source, pinned upstream source/license, DLL bundle, managed adapter/session patch, regression coverage and scoped pushed commit.

## 需求覆盖矩阵
| Requirement | Delivery |
| --- | --- |
| FR-1 | Full console and authenticated API proxy |
| FR-2 | Native Cline provider, models and streaming executor |
| FR-3 | Private local data, proxy policy and owned lifecycle |
| FR-4 | Package, installed verification and scoped push |

## 文件变更清单
New vendor/cpa-plugins/cline-pass-switcher source; bundled DLL/BUNDLE.json; electron/cpa-managed.cjs and cpa-panel-session.cjs; focused CPA tests.

## 任务列表

- [x] Confirm pinned upstream, CPA ABI, caller impact, proxy/runtime and installed app paths.
- [x] Add focused failing coverage for plugin registration/provider/console and scoped panel credentials.
- [x] Implement the native adapter over the pinned switcher; preserve original upstream assets and MIT notice.
- [x] Build and pin the Windows x64 DLL; extend managed config, bundle and panel integration.
- [x] Run native/CPA panel/package checks and isolated DLL startup/stream tests.
- [x] Patch the installed app recoverably and configure the approved local Cline account.
- [x] Verify live plugin/model/account/inference behavior without logging credentials.
- [x] Review and graph-check the scoped diff; commit/push only task files.
- [x] Clean task-owned temporary processes/artifacts; retain necessary recovery backups.
