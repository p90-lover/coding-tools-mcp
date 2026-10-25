# Tasks

## 交付物清单
Two source modules, focused MCP integration tests, existing contract snapshot updates, and these three specification files. No installed runtime or composer changes.

## 任务列表

- [x] 1. Improve direct and nested inventory keyword/schema handling (FR-1; design: Inventory). Evidence: replaced literal phrase matching and preserved supplied schemas; missing schemas are explicit. File: mcp-server.ts.
- [x] 2. Add authenticated start/poll receipts and request-ID deduplication (FR-2, FR-4; design: Invocation receipts). Evidence: queued/dispatched/completed status, same-ID replay and conflicts passed through real MCP. Files: turn-broker.ts and mcp-server.ts.
- [x] 3. Add human-confirmed app calls without changing native authority (FR-3; design: App consent). Evidence: approval dispatches exact arguments; unavailable, declined, cancelled and unchecked confirmations dispatch nothing. File: mcp-server.ts.
- [x] 4. Verify acceptance through MCP and existing lifecycle tests (FR-1 through FR-4; design: Verification). Nine tool/consent/contract and seventeen lifecycle checks passed, plus TypeScript. These use controlled tools; live ChatGPT confirmation support and external app operations remain unverified. Test command uses --timeout 30000 for Windows process startup.

## 需求覆盖矩阵
FR-1: task 1 and keyword/schema tests. FR-2: task 2 and pending/dedup tests. FR-3: task 3 and consent/denial tests. FR-4: task 2 and turn-isolation/status tests.

## 文件变更清单
mcp-server.ts: inventory, receipts and app consent. turn-broker.ts: receipt lifecycle. Tool integration and existing MCP contract tests: acceptance and compatibility. Specification files: requirements, design and tasks.
