# Terminal watch tasks

- [x] 1.1 Implement scoped bounded watch state and model-visible watch/list/cancel calls.
  - 证据块: chat-agent-tools.cjs:1565 (catalog), :2161 (known handles), :2292 (tracking), chat-sandbox.cjs:345 (snapshots).
  - Files: chat-command-watches.cjs, chat-agent-tools.cjs, backend-bundle.cjs and tests.
  - _Requirements: FR-1, FR-2_
- [x] 1.2 Verify completion/error/expiry/cancel states, deduplication, bounds and empty-input wait guidance.
  - 证据块: chat-agent-tools.cjs:385, :2370; chat-sandbox.cjs:329.
  - Files: watch and MCP regression tests.
  - _Requirements: FR-3_
