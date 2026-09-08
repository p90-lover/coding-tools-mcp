# Paseo + Anneal control center

This release integrates the two projects at the management/observation layer, not by bundling their complete execution engines. The redesign remains a native Svelte 5 / Tauri 2 desktop application.

## Product surfaces

The new persistent navigation opens Overview, Work board, Agent sessions, Computer control, Connections and Integrations. Workspaces remain directly accessible; the workspace page separates computer control from service configuration and collapses metadata/project handoff details. Retained settings, tunnel, authentication, permission, log and health forms use the shared neutral design tokens. The overview uses real local workspace/runtime stores, explicit unavailable states, and in-memory external snapshots instead of sample metrics. The search palette jumps to pages or workspaces with Ctrl/Cmd+K. New screens support English/Traditional Chinese and light/dark themes; some retained advanced forms keep their pre-existing language. The responsive shell supports compact screens; the native installer retains its existing minimum window dimensions.

## Paseo integration

Pinned source: getpaseo/paseo da8c1b5c94e752b01d451645e5fa52aba2c1b2f0 (Apache-2.0).
The native adapter performs a protocol-v1 hello and one correlated fetch_agents_request over the existing daemon's WebSocket. The UI shows actual session title, lifecycle, provider, workspace path, pending permission count and attention reason. The attributed upstream status/priority module is used, not a similarly named placeholder. Unknown lifecycle values are not represented as successful completion.

Default endpoint: ws://127.0.0.1:6767/ws. Set the configured daemon password when needed. The adapter does not create an agent, send a prompt, approve permissions, resume, stop or archive an existing agent. It does not provide Paseo relay/device pairing, voice, remote desktop/mobile clients or chat execution. Those runtimes are not installed or started.

## Anneal integration

Pinned source: mosonlab/anneal 088f0d5971a1692134aaa3db0230cc541b014c07 (MIT).
The native adapter sends only GET /tasks?view=board&archived=false to an already-running API and projects task state, chain metadata and approval gates. The attributed chain-order module preserves layer-first/index/id ordering. Default endpoint: http://127.0.0.1:3000/. Enter the operator token when configured. Upstream Anneal supports macOS/Linux, not native Windows; a user-managed secure local port forward can expose a remote API locally. No Docker/runner installation or startup occurs.

The separate local delivery board is useful without either external service. Select an existing workspace, create a specification, start its twelve-stage checklist, record evidence for each stage, block/resume, archive and restore. Evidence is explicitly an operator attestation, not an autonomous verification result. Completing Delivery does not merge a pull request. This is not Anneal's scheduler, independent agent reviewers, merge engine or complete subscription-powered Full Assurance runner. No agent chain, spec execution or external mutations are exposed.

## Persistence and limits

Local tasks and evidence are persisted through the existing serialized DataStore update transaction. An additive defaulted control_board field preserves old profiles; revisions reject stale concurrent changes. Archived tasks and their evidence remain present. The board keeps up to 250 retained tasks, twelve steps per task, titles up to 240 UTF-8 bytes, specifications 8192 bytes, and evidence notes 4096 bytes. No screenshot content is stored in this board. Do not paste credentials into task notes. Before downgrading, preserve your application data using the app's existing backup mechanism; older builds do not know the new field.

Integration credentials and fetched snapshots stay in RAM and are not added to profiles, browser localStorage, sessionStorage or logs. Credential input clears when a read begins; enter it again to refresh a protected source. Only locale/theme preferences persist in browser storage. No claim of cryptographic RAM erasure is made; operating-system paging/crash dumps and third-party receiving clients remain separate.

Endpoints are limited to literal IPv4/IPv6 loopback and expected root paths. No redirects, DNS resolution for arbitrary hosts, explicit proxies or arbitrary HTTP methods are used. Two concurrent reads, an eight-second overall deadline, two-MiB response/frame limits, capped frames and 200 projected records bound work. Partial responses are visibly labelled. Duplicate IDs are rejected. Refresh is manual; last-fetched timestamps and failed-refresh warnings distinguish snapshots from live state.

## Preserved safeguards and scope

Existing memory-only screenshots, Live target/Exact agent frame, remembered application approvals, background-window observation, local monitor/Stop and Ctrl+Alt+Esc behavior remain unchanged. The new commands are main-window-only and are not exposed as remote MCP execution tools. The previously withheld Codex-derived command sandbox stays withheld and is not bundled or enabled.

No Codex/model API client, CLI agent, reviewer, subscription proxy or fallback is used by this integration or its checks. Reading an externally running agent cannot prevent that agent's independent provider consumption. Silent ChatGPT registration/reauthorization, Windows publisher signing and Mac notarization are not added by this release.

## Verification scope

Three focused native tests cover strict adapter/board boundaries, a local HTTP Anneal fixture, and a local WebSocket Paseo fixture that checks the exact outgoing read-only RPCs and correlation IDs. Pure frontend contracts check the reused upstream logic. Existing Windows control and vision contracts plus a real isolated Windows background-observation/input fixture gate release. Actual native installers are inspected with their binary version and original-byte identity checks; experimental sandbox helper absence is enforced.

The container's managed Chromium rejected navigation to the local dev server (ERR_BLOCKED_BY_ADMINISTRATOR). Its policy was not changed. An offline harness compiled the actual production Svelte components, substituting only routing and native IPC fixtures, and rendered them in about:blank. Task creation/evidence/archive/restore, source snapshots, filtering, search, English/Traditional Chinese, desktop/mobile and theme states were inspected. This is component-level rendered verification, not full native WebView or live user-daemon end-to-end verification. No Image Gen tool was available; the redesign is code-native, not a claimed image-generated concept. No screenshots are saved by the production feature.

## 繁體中文

此次在管理／觀察層整合 Paseo 及 Anneal，並重新設計原生 Svelte／Tauri 控制中心，不是打包兩者完整的 Agent 執行引擎。新頁面涵蓋總覽、本機任務看板、Paseo 會話、Anneal 流程、電腦操作、連線與整合設定。介接器只讀取已運行服務，使用固定上游協定及附授權的排序元件，不啟動 Codex 或其他 Agent。

本機十二階段看板可建立規格、記錄依據、標記受阻、恢復、封存及還原；依據是使用者確認，不代表自動驗證或 GitHub 合併。既有截圖只留記憶體、記住授權、背景觀察、監控及停止保障保留。外部 Token／狀態只在記憶體，本機任務與文字依據則透過既有資料儲存機制持久保存。外部 Agent 如已運行，仍可能自行消耗供應商配額。

真正的 Paseo Relay／語音／Agent 執行、Anneal Runner／排程／自動合併、ChatGPT 靜默授權及先前暫緩的命令沙箱均未包含。Anneal 上游未支援原生 Windows。本次原生協定測試使用受控本機服務，介面測試使用實際元件的離線測試環境，並非已驗證你的真實外部服務或帳戶。
