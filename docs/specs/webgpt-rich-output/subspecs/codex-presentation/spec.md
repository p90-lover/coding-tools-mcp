# 子规格：Codex presentation and verification

## 范围

Present rich output through native-compatible messages and usable owned source previews, then verify the complete response matrix.

## 需求回链

- FR-3
- FR-7

## 验收标准（EARS）

1. WHEN a captured item has a safe usable reference THEN the final Codex response SHALL preserve access to it through existing supported output contracts.
2. WHEN interactive content depends on a ChatGPT-only renderer THEN the response SHALL offer its owned source view for Codex's browser, without presenting a static snapshot as fully interactive.
3. WHEN output is streamed, resumed or completed THEN rich references SHALL be associated with the correct turn and presented once before completion.
4. WHEN verification is reported THEN tests SHALL distinguish data transport, native host rendering and source-browser interaction; unavailable live host capabilities SHALL be recorded explicitly.

## 涉及文件

WebGPT adapter, prompt/presentation helpers and bridge/harness tests; local synthetic interactive browser fixture.

## 不做项

No installed client patch/restart, live mutation of user records or unsupported native renderer claims.

## 设计要点

Use existing SSE text/function contracts. Keep source previews explicit about account context and preserve normal link safety.
