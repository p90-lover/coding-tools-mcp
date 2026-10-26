# 子规格：Native tool metadata and result fidelity

## 范围

Preserve supplied native tool metadata and canonical MCP result envelopes across parsing, broker and continuation paths.

## 需求回链

- FR-4
- FR-5

## 验收标准（EARS）

1. WHEN a supplied tool descriptor includes UI metadata, annotations or an output schema THEN the system SHALL retain them through supported registry/inventory paths.
2. WHEN a result contains text, media, resource links, embedded resources or structured data THEN the broker SHALL preserve its supplied canonical envelope.
3. WHEN result `_meta` contains component-only data THEN the system SHALL keep it out of ordinary model-visible message text.
4. WHEN the outer host omitted metadata or cannot serve a UI resource THEN the bridge SHALL not fabricate that capability or bypass tool approval/identity checks.

## 涉及文件

Core types, Responses parser, WebGPT adapter broker result mapping, compaction handoff and MCP server; focused parser/broker/harness tests.

## 不做项

No arbitrary resource proxy, new native tool authority, invented output item types or permission changes.

## 设计要点

Keep the legacy text/image model projection compatible. Treat the canonical envelope as a separate channel and preserve exact native tool names/namespaces.
