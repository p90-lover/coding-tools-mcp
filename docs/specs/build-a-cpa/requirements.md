# 需求文档：build-a-cpa

## 功能概述
Provide a CPA plugin called Codex Auto Review that lets the user select one existing Codex account for the exact model codex-auto-review.

## 历史经验与坑（来自记忆库）
Current evidence replaces historical assumptions: CPA returned unknown provider while all 16 Codex accounts were disabled. Enabling the one account authorized by the user registered the model and produced a real allow verdict. Reuse the existing Cline plugin ABI and management-page conventions.

## 术语定义
- Review model: the exact model ID codex-auto-review.
- Selected account: a stable opaque host.auth.list ID belonging to provider codex.
- Pin: force one auth ID for execution and retries, with no other account fallback.

## 范围边界
In Scope: plugin routing, sanitized account selector, local selection persistence, Windows DLL bundle, focused tests and live review verification.
Out of Scope: signing in new accounts, copying credential JSON, changing other models, automatic account rotation, changing review model or safety decisions.

## 需求列表
### FR-1: Select a configured Codex account
**优先级:** Must
**用户故事:** As the user I want a plugin account picker so I control which account handles permission reviews.
#### 验收标准（EARS）
1. WHEN the settings page opens THEN the plugin SHALL list only sanitized Codex account metadata.
2. WHEN an available Codex account is selected THEN the plugin SHALL persist only its stable auth ID.
3. IF an unknown, disabled or unavailable account is selected THEN the plugin SHALL return a clear error and preserve the previous selection.

### FR-2: Pin only the review model
**优先级:** Must
**用户故事:** As the user I want review requests to use the selected account without changing worker routes.
#### 验收标准（EARS）
1. WHEN requested model equals codex-auto-review THEN the plugin SHALL execute it through the native codex provider with selected auth_id.
2. WHEN any other model is requested THEN the router SHALL return Handled false.
3. WHILE one request runs THE plugin SHALL keep its initial selected account for streaming, execution and retry.
4. IF the selected account is missing, disabled, unavailable or quota-limited THEN the request SHALL fail clearly without falling back to another account.

### FR-3: Install and verify the plugin
**优先级:** Must
**用户故事:** As the user I want the plugin in the existing CPA plugin menu with a tested Windows binary.
#### 验收标准（EARS）
1. WHEN the bundled plugin is installed THEN CPA SHALL expose its management page and settings APIs.
2. WHEN a synthetic review is sent THEN execution evidence SHALL identify the selected account without exposing credentials.
3. WHEN the plugin is disabled by the user THEN the ordinary CPA host behavior SHALL resume.

## 非功能需求
- NFR-1: Selection lookup is local and adds no provider network call.
- NFR-2: No auth tokens, paths or credential JSON are returned to the page or stored in plugin selection.
- NFR-3: Use the pinned CPA 8.0.32 ABI and existing Windows amd64 plugin packaging.
## 依赖关系
Existing CPA 8.0.32 plugin host; host.auth.list; host.model.execute and execute_stream; existing Cline plugin ABI pattern.
## 检查清单
- [x] Scope, error behavior, stable FR IDs and current evidence are explicit.
