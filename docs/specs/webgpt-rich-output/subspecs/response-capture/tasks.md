# 子任务：Rich response capture and transport

- [x] 1.1 Capture bounded typed rich references before Markdown cleanup.
  - 证据块: browser-worker responseDomSnapshot/chatGptMarkdownContent and existing Markdown/chart tests.
  - 涉及文件: browser-worker.ts, rich-output utility and focused tests.
  - _需求: FR-1, FR-2_
- [x] 1.2 Carry rich references through helper IPC and turn lifecycle without duplication.
  - 证据块: optional BrowserTurn callback, negotiated helper event and success-only adapter finalizer; existing string turn contract remains unchanged.
  - 涉及文件: helper/turn source and transport tests.
  - _需求: FR-6_
