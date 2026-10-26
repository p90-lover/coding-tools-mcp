# 设计文档：WebGPT rich output

## 概述

对应需求: FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-7.

Use two independent channels: readable streaming text and typed rich response references. Native tool results retain their canonical envelope separately from their model-visible text/image projection.

## 技术方案

1. Collect rich references from the owned assistant response before removing controls/chart/preview elements for Markdown conversion.
2. Carry a bounded typed rich-output value through BrowserTurn and helper IPC. Preserve the original streaming callbacks.
3. Emit compatible final Markdown references through the existing text SSE contract. Web-only interactive views link to the owned source conversation, which can be opened in Codex's browser. Do not invent artifact/widget SSE types.
4. Preserve supplied canonical native result fields separately from the legacy text/image projection. Broker and compaction paths use that envelope when present. Component-only `_meta` is not serialized into public text.
5. Retain tool descriptor UI metadata where supplied. Native resource rendering still belongs to the original host and resource server; this bridge must not advertise a resource it cannot serve.

## 跨模块契约

- Rich output: owned source URL plus typed items identifying image/file/audio/video/chart/app/artifact references. Unsafe or transient URLs use the owned source preview instead of a broken direct link.
- BrowserTurn: optional rich-output notification, preserving compatibility for existing callers.
- Helper IPC: an explicit validated rich-output event, never an unrecognized ad-hoc payload.
- Native tool result: optional canonical envelope with content, structuredContent, isError and component-only metadata; normal message content remains a safe model-facing projection.
- Presentation: deduplicate references and append them once before terminal completion, without rewriting text already streamed.

## 文件结构

- Capture: `runtime-web/src/adapters/chatgpt-web/browser-worker.ts` and a focused rich-output utility.
- Transport: browser helper main/client and turn execution.
- Tool fidelity: `runtime-web/src/types.ts`, Responses parser, WebGPT broker result mapping, compaction handoff and MCP server gateway.
- Presentation: WebGPT adapter and existing Responses bridge tests.

## 设计决策

Preserve live source views rather than cloning arbitrary iframe HTML. No new renderer dependency, arbitrary HTML execution, authentication bypass or desktop client patch is required for the browser fallback. Keep visible reasoning summaries distinct from private model reasoning.

Official contracts: [MCP UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui), [plugin reference](https://developers.openai.com/plugins/reference). Capability checks and actual rendering evidence take precedence over assumed feature parity.
