# Antigravity coding filter design

## 概述

Add one plugin to the existing CPA integration.

## 技术方案: Interception

Use CPA's existing native C ABI and request-interceptor capability. The before-auth hook returns no changes. The after-auth hook checks the host's selected upstream ToFormat (antigravity) before filtering the original Anthropic system field. It returns a replacement body or a v8 termination response, never an executor or a model route. This preserves CPA's routing, credentials, tool translation and streamed response paths (FR-1, FR-2).

Decode the outer JSON into raw fields and system blocks into raw fields so unrelated values remain intact. Compile literal, case-insensitive patterns ordered longest first and perform a single replacement pass. Never rewrite block metadata or nested user/tool objects. Parse the lifecycle's YAML with the same yaml.v3 dependency used by the existing Cline plugin. Invalid configuration rejects reconfiguration without changing the active filter (FR-2).

## Integration

Add the DLL to COMMANDCODE_PLUGINS and the existing BUNDLE manifest. Add default configuration under antigravity-coding-filter with rewrite mode and enabled default keywords. Merge saved settings over this plugin's defaults specifically, preserving explicit disabling and custom mappings. No general configuration refactor is needed (FR-3).

## 文件结构

Source and tests live under desktop-electron/vendor/cpa-plugins/antigravity-coding-filter. The distributable lives under vendor/bundled/cpa-plugins/windows/amd64. Configuration changes stay in electron/cpa-managed.cjs.

## Verification

Go tests exercise the lifecycle and interception contract, Unicode and lossless unrelated JSON. Node integration tests check the pinned bundle, installation and repeated configuration refresh. An isolated CPA process with fixture credentials verifies registration and, where feasible, an instrumented fixture executor confirms forwarding. All scratch state and build caches live under the task's aiTemp directory; the existing portable Go/Zig toolchains are reused (FR-4).
