# Tasks
## 交付物清单
Modify connector setup, main IPC, account plan normalization, preload/types and Browser Management; extend focused connector, registry and rendered tests. Add no dependency or new public configuration.
## 任务列表
- [ ] T1: Extend authenticated workspace inspection and same-workspace owner/admin selection with mutation guards. Evidence: mcp-connector-setup.cjs:10 chatGptMcpContext validates fresh account_id and account_user_role; :577 createConfiguredConnector currently creates only in one partition. Budget: existing module plus a small workspace helper only if needed to keep lifecycle code readable. Requirements FR-1, FR-2, FR-3. Design Workspace setup.
- [ ] T2: Preserve original-member consent, exact tunnel identity and failed-creation provenance through sharing. Evidence: mcp-connector-setup.cjs persists mcp-account-connector-bindings.json before consent; main.cjs:3004 accepts a local account id. Budget: setup and main modifications, no unrelated service rewrite. Requirements FR-3, FR-4. Design Errors and recovery.
- [ ] T3: Record authoritative plan metadata and refresh each partition without switching. Evidence: browser-accounts.cjs:38 normalizePlan only stores solAvailable/proAvailable; ChatGptBrowserManagement.tsx:39 labels proAvailable Team or Pro. Budget: registry, main, preload, types and component changes. Requirements FR-1, FR-5. Design Plans.
- [ ] T4: Exercise all acceptance cases in focused tests, typecheck and actual rendered UI, then complete required review and PR delivery. Evidence: existing mcp-connector-setup.test.cjs includes production popup/consent fixtures. Budget: existing test files and one focused new test file if required. Requirements FR-1 through FR-5. Design Validation.
## 需求覆盖矩阵
FR-1 T1/T3/T4; FR-2 T1/T4; FR-3 T1/T2/T4; FR-4 T2/T4; FR-5 T3/T4.
## Checkpoints
Spec check before implementation; focused regression and real rendered output before review; graph change analysis and clean isolated diff before commit/push. Keep live connection limitations explicit.

## 文件变更清单
Connector setup/main handle workspace discovery and guards; registry/preload/types/management handle authoritative plan metadata and refresh; focused tests protect both behaviors. No generated distribution is committed.
