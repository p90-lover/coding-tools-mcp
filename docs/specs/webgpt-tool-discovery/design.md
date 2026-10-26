# Design

## 概述
Extend the current native MCP contract with bounded receipts and explicit app consent.

## 技术方案

## Inventory (FR-1)
Reuse the existing direct/native and exec gateway catalog paths. Normalize keywords and explicit aliases identically for both paths. Carry optional parameters/inputSchema metadata from nested catalogs. Return schema availability and discovery tools with inventory results, without inventing exact schemas from descriptions.

## Invocation receipts (FR-2, FR-4)
Extend the existing authenticated turn broker with start/poll operations while retaining the original invoke ABI. A receipt uses the existing native call ID. Starting is acknowledged immediately; polling observes the same promise. Completed results are kept within the owning live turn. Identical request IDs share one receipt; conflicting payloads fail. A bounded capacity rejects before dispatch. The MCP server returns pending before its tunnel deadline and exposes a status tool. Expired or cancelled turns retain the existing fail-closed behavior.

## App consent (FR-3)
Add codex_app_call for an exact app wire name, structured arguments and a reason. MCP form elicitation asks the human to approve that exact action. Only an accepted boolean confirmation dispatches to the native app tool. The model cannot provide its own approval field. Unsupported clients fail closed. Existing native tool approvals and app connection controls remain authoritative.

## Verification and rollout
Use controlled MCP clients and native tool queues; never perform external writes. Update native/safe connector ABI snapshots intentionally; an existing cached ChatGPT connector needs refresh after deployment. Publication is source-only. Production app integrations are recommendations, not installations.

## 文件结构
Production changes stay in runtime-web/src/adapters/chatgpt-web/mcp-server.ts and turn-broker.ts. Regression coverage stays under runtime-web/tests.
