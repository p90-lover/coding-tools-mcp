# Design

对应需求：FR-1, FR-2, FR-3, FR-4.

## 概述
Full approved native CPA integration over the pinned upstream switcher.

## 技术方案
Reuse CPA v8's native C ABI and authenticated ManagementAPI/resource routing, following the existing bundled Go plugins. A small native adapter owns a loopback child running the pinned zero-dependency upstream server and unchanged console assets. Delegation preserves the upstream switcher behavior rather than reimplementing its routing algorithms.

Register a native Cline auth/model/executor provider. A local bridge auth record identifies the switcher; real Cline account credentials remain in the switcher account pool. Model discovery reads its local model catalog; inference relays the full OpenAI payload and strips only SSE framing for CPA's native stream callbacks. Upstream errors preserve HTTP status and retryability.

## 文件结构
- New plugin source and pinned upstream/license under desktop-electron/vendor/cpa-plugins/cline-pass-switcher.
- Add the DLL to the existing cpa-managed installer and bundle manifest; retain hash checks and recoverable plugin replacement.
- Configure the child with the existing managed runtime, a private data directory and loopback binding. The native adapter uses a private generated proxy credential; console API requests are validated by CPA, never by an exposed management secret.
- Extend the existing CPA panel marker exchange only for the owned Cline resource frame and its exact management route prefix.
- Keep upstream key storage local; seed the approved key only through the installed local account API.

## Verification and rollback
Focused native tests cover registration, exact management routing, lifecycle, model discovery, HTTP errors and SSE preservation. Existing CPA adapter/panel tests cover packaging and credential frame isolation. An isolated CPA run verifies the actual DLL. Patch only installed task-owned resources, retaining backups; use the app's keep-bridge restart if required. Rollback restores prior adapter/bundle/panel files and disables the new plugin without modifying other account data.

## Known risks
GitNexus was stale and its worker refresh failed; exact graph impact attempts and source callers must be reconciled before editing. Native plugin delivery currently follows the repository's Windows x64 bundle support. Unrelated source edits must not be included when pushing.
