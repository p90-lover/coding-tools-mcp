# Antigravity coding filter

Let Claude Code use CPA's Antigravity models by rewriting configured coding-client names in system text. The reference is jellyfish-p/cpa-plugin-antigravity-coding-filter at bed909ef1ed9a73543324113de67f49312572058 (MIT).

## 功能概述

Provide a provider-scoped, configurable coding-client word filter for CPA.

## 需求列表

- FR-1: Register a native CPA v8 request interceptor. After credential selection, apply it only when the selected provider is Antigravity; never infer the provider from the requested model alias.
- FR-2: Support case-insensitive default keywords and custom mappings, with rewrite and block modes. Managed installs default to rewrite. Rewrite only top-level Anthropic system text, preserving user messages, tools, cache controls, numbers and streaming flags.
- FR-3: Bundle the Windows amd64 DLL with its source, license, version and digest. Reuse the existing bundled-plugin installer and configuration generator. Preserve custom filter settings, including explicit disabling, across refreshes.
- FR-4: Verify lifecycle, provider selection, matching, block status, request preservation, DLL loading and configuration persistence with focused checks. Deliver a scoped PR without merging or changing credentials.

## 非功能需求

The plugin SHALL preserve unrelated JSON values and avoid touching credentials or response streams. Build and test artifacts SHALL remain on the project drive.

## 验收标准

1. An Antigravity request containing Claude Code in system text forwards Antigravity instead; user text and tool payloads containing the same words remain byte-identical JSON values.
2. Requests assigned to another provider and requests without a match return no body replacement.
3. Custom mappings, disabled presets, Unicode text and large JSON integers behave correctly. Block mode returns an HTTP 403 termination response without taking over inference.
4. A real CPA v8 fixture registers the DLL and invokes its interceptor. Saved filter settings survive two configuration generations.

## Scope

Local source and bundled plugin integration only. Existing credentials, model catalogs, response streaming and executors retain their current behavior. Live provider acceptance requires an authenticated request and is recorded separately from fixture evidence.

## 依赖关系

CPA v8.0.46, the existing bundled-plugin installer, portable Go/Zig and yaml.v3.
