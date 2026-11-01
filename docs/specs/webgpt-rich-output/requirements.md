# 需求文档：WebGPT rich output

## 功能概述

The user wants WebGPT responses, interactive charts/apps and artifact previews usable from Codex. The current bridge captures Markdown while removing preview/chart elements, and narrows native tool results to text and images. Preserve available response families and expose a usable source preview when the host cannot render a web-only component.

## 范围边界

- In scope: text/code/tables/citations, public progress summaries, rich content references, native tool descriptor/result fidelity, compatible inline output and source-backed previews, regression coverage.
- Out of scope: exposing private reasoning, copying cookies, inventing native Codex UI event types, changing approval policy, modifying pinned vendor files, installing or restarting apps without separate authorization.

## 需求列表

| FR ID | Requirement | 主子规格 |
|---|---|---|
| FR-1 | Preserve existing streamed text, formatting, citations and visible progress summaries. | response-capture |
| FR-2 | Capture image, file, audio, video, chart, app and artifact references before Markdown cleanup, bound to the owned response. | response-capture |
| FR-3 | Present supported content in Codex and provide a usable owned source preview for web-only content. | codex-presentation |
| FR-4 | Preserve supplied tool UI descriptors and canonical content/structuredContent/isError/_meta result fields. | native-tool-envelope |
| FR-5 | Keep component-only result metadata out of ordinary model-visible text and preserve native tool identity/approvals. | native-tool-envelope |
| FR-6 | Preserve streaming latency and terminal ordering; avoid duplicate or stale rich content across tool rounds and continuation. | response-capture |
| FR-7 | Verify each response family and distinguish transport, native rendering and browser fallback evidence. | codex-presentation |

## 非功能需求

- No asset download or preview discovery may block ordinary text streaming.
- Treat captured URLs/content as data. Reject executable URI schemes; do not execute captured HTML in the privileged app.
- Only the active assistant response may contribute references. Source previews use the owned conversation, not an unrelated tab.
- Existing tool approvals, sandbox context and helper transport bounds remain enforced.
- Missing host metadata cannot be reconstructed. Report that boundary instead of manufacturing support.

## 依赖关系

See the manifest and the existing BrowserTurn, helper IPC, broker and Responses SSE contracts.
