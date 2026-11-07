# Continuation tasks

- [x] 2.1 Register current run ownership and deliver terminal outcomes through serialized follow-up turns.
  - 证据块: agent-orchestrator-workflow.cjs:5412 (chatSend), :5698 (route), :6604 (sessionChat), main.cjs:4681 (service wiring).
  - Files: workflow, main and tests.
  - _Requirements: FR-4_
- [x] 2.2 Fence stale/cancelled delivery and verify races, Stop and unknown outcomes.
  - 证据块: agent-orchestrator-workflow.cjs:5484 (saved parent), :7853 (dispose), chat-agent-tools.cjs:2812 (Stop).
  - Files: workflow, tool server and regression tests.
  - _Requirements: FR-5_
- [x] 2.3 Return verifiable registration and teach real watch/wakeup use; run parity and adjacent regressions.
  - 证据块: chat-agent-tools.cjs:1204 (waiting instructions), :1931 (wake registration).
  - Files: tool server, specs and tests.
  - _Requirements: FR-6_
