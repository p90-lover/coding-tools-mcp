# Tool parity and long-horizon reliability

## 功能概述

Compare Coding Tools' callable tools and runtime semantics against current public Codex source and official ChatGPT/Codex documentation, then repair demonstrated long-task blockers. Product features and hosted capabilities are not interchangeable with local tool names.

## 范围边界

In scope: documented capability inventory, sandboxed terminal timing, bounded recoverable output and own-server preview detection; deterministic regression tests and a scoped PR. Out of scope: bypassing approvals, replaying unknown side effects, automatic Google/OpenAI account operations, proprietary hosted web/research/image/voice services, true PTY implementation, restart-surviving processes, or installation over the running app.

## 历史经验与坑

An execution yield is only a wait budget, not a runtime limit. A tool failure or quiet output is not proof that a command did not run. Live command handles must not be pruned. Screenshots, output and provider facts must remain bounded; no new disk logs or system-drive storage. Existing permission and sandbox checks remain in force.

## 术语定义

- Yield: how long a tool waits before returning an owned command handle.
- Deadline: an optional caller-requested process runtime limit.
- Output reference: an absolute raw-byte cursor into bounded in-memory stream history.

## 需求列表

### FR-1: Evidence-based parity inventory (Must)

WHEN comparing tools THEN document existing equivalents, genuine missing/hosted capabilities and platform/permission differences without claiming access to ChatGPT's private implementation. WHEN reporting remaining limitations THEN distinguish local tests from live production verification.

### FR-2: Safe long-running command lifecycle (Must)

WHEN no timeout, null or zero is supplied THEN the sandbox SHALL impose no automatic deadline. WHEN a valid positive timeout is supplied THEN it SHALL supervise that same owned process tree, report timeout rather than success and retain readable output. IF timing input is invalid THEN no command SHALL start. WHEN the call yields or ends after acceptance THEN it SHALL not relaunch or implicitly cancel the accepted process. Very large explicit deadlines SHALL not overflow Node timers into an immediate stop.

### FR-3: Bounded and truthful output (Must)

WHILE output streams grow THE retained bytes SHALL not exceed four MiB per stream, including a single oversized chunk. WHEN old bytes or a response tail are omitted THEN returned metadata SHALL expose the gap/truncation and usable output references. WHEN a tail starts inside UTF-8 THEN it SHALL not inject a false replacement character for a valid split scalar. WHEN a command is killed/timed out THEN zero exit status SHALL not be advertised as command success.

### FR-4: Preview avoids unused terminal probes (Must)

WHEN deciding consent for a new preview origin THEN the app SHALL not read command output that has no effect on that decision. WHEN an origin has not been approved or reviewed THEN existing preview consent SHALL still apply, even if the agent printed its address in terminal output. Another chat SHALL not inherit origin approval.

### FR-5: Rediscover owned command handles (Must)

WHEN a tool reply is lost after command acceptance THEN the agent SHALL be able to list its own known command handles and resume observation without relaunching. Listing SHALL be read-only, paginated, gated by the terminal setting, and contain no other chat's handles, raw commands or credentials. Returned status SHALL be labeled last-observed, not a fresh process probe. WHEN stopping a process fails THEN ownership SHALL remain available for an explicit retry and the tool SHALL not claim it was killed.

## 非功能需求

No new production dependency, polling daemon, request log or eager build. Existing terminal isolation, consent and non-sandboxed behavior remain intact. Run complete affected Node suites and retain concrete before/after regression evidence. No promise of obstacle-free unattended execution or recovery across app restarts.

## 依赖关系

Existing chat-agent-tools.cjs, chat-sandbox.cjs and tests; current headless exec timing contract. Optional Codex sandbox installation remains required for real sandbox execution.

## 检查清单

- [x] Stable requirements have observable acceptance criteria.
- [x] Security boundaries and hosted-product differences are explicit.
