# Workspace-aware MCP setup and account plans
## 功能概述
Browser Management sets up the configured Coding Tools connector through an existing, signed-in administrator of the same workspace when a member cannot create it. Show the subscription reported by ChatGPT separately from model capabilities.
## 需求列表
- FR-1: Read fresh ChatGPT user identity, selected workspace id, structure, role and plan from the authenticated account. Never infer roles or plan from model access, email, display name or a stale JWT workspace claim.
- FR-2: Search saved signed-in accounts for an accessible owner/admin membership of the exact target workspace. Route each partition through its configured proxy. Recheck role, user and workspace before publishing.
- FR-3: Reuse verified exact tunnel provenance, create/share only the configured connector, then connect and verify the original member. Keep each consent in its own partition. Never promote roles or change workspace security policy.
- FR-4: Keep tunnel/server authorization failures distinct from missing workspace authority. Explain missing administrator and missing sharing permissions without claiming connection.
- FR-5: Persist authoritative plan metadata separately from capability booleans. Refresh signed-in accounts without switching the Browser account. Clear identity-dependent metadata after sign-out or user changes and label old results as historical.
## Acceptance
Exact workspace owner/admin fallback succeeds in a fixture, unrelated workspace and stale roles are rejected, partial failure keeps recoverable creation, and positive original-member connection is required. Team metadata displays Business instead of Team or Pro; Pro, Plus, Free and unknown plans remain distinct. Existing capability-based bridge configuration remains compatible. Focused tests, typecheck and rendered UI checks pass. Public PR contains only task changes.
## 非功能需求
No credentials leave their page, no permission bypass, no new dependency. Existing dirty checkout is preserved in an isolated worktree. Live account checks are read-only until the implementation is verified; source tests cannot establish real account connection.

## 依赖关系
Existing Electron account partitions, ChatGPT workspace metadata and connector helper are reused.
WHEN a signed-in account refreshes, the application SHALL display only its verified server plan type.
