# Cline Pass CPA plugin

## 功能概述
Integrate [munmunjaklin458-afk/cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher), pinned at 02538a3137a08948a94f26f17dd4aeff8c029ed1, as a bundled native CPA plugin. Ethan approved the full console integration on 2026-10-03. Preserve existing providers, proxy policy, unrelated worktree changes, and active Codex work.

## 需求列表
### FR-1 Full console
WHEN CPA starts on Windows x64, THE SYSTEM SHALL register the Cline Pass plugin and its console in CPA Plugins. THE SYSTEM SHALL retain upstream account pooling, per-model upstream selection/exclusion/failover, discovery, testing, history, and model refresh controls.
### FR-2 Native Cline provider
WHEN a Cline account is configured locally, THE SYSTEM SHALL expose Cline Pass models through CPA's authenticated provider route, supporting ordinary and streamed OpenAI chat requests, including reasoning and tool-call payloads. Other providers SHALL remain unchanged.
### FR-3 Secrets and lifecycle
THE SYSTEM SHALL keep account keys in private local runtime data, never in source, test fixtures, commit messages, or output logs. THE SYSTEM SHALL authenticate console APIs through CPA management, bind the delegated service to loopback, honor the selected outbound proxy, and own/stop its child process.
### FR-4 Delivery
THE SYSTEM SHALL package a verified native plugin, verify isolated startup/API/auth/streaming behavior, patch the installed Coding Tools app recoverably, add the supplied local Cline account, and push only task-owned files. Temporary outputs SHALL remain under aiTemp.

## 非功能需求
Private secrets, loopback listeners, bounded tests and recoverable installation are required.

## 依赖关系
Existing CPA 8.0.2 native ABI, managed Bun runtime and upstream MIT source; no new JavaScript dependencies.

## Acceptance
- CPA lists the enabled plugin and its working console.
- Local account readback confirms configuration without printing the key.
- CPA model discovery and bounded non-stream/stream inference work through the plugin.
- Scoped tests and package checks pass; installed-state proof is recorded separately from source tests.
- Pushed commit excludes secrets and unrelated edits. Existing required recovery backups are retained.
