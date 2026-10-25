# 子任务：Native tool metadata and result fidelity

- [x] 1.1 Preserve supplied descriptor metadata and canonical result fields through parser, broker and compaction.
  - 证据块: types.ts, parser outputToToolResultContent/buildTools, BrokerToolResult/asMcpResult and codexToolResultToBrokerResult.
  - 涉及文件: core/parser/adapter/MCP source and focused regressions.
  - _需求: FR-4_
- [x] 1.2 Verify component-only metadata privacy and native identity/approval behavior.
  - 证据块: existing exact-tool gateway and full native harness tests.
  - 涉及文件: gateway/compaction tests and privacy assertions.
  - _需求: FR-5_
