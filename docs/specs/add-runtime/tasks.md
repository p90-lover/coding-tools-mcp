# Orchestrator Team presets: tasks

## 交付物清单
Runtime team-manager surface, persisted named/default teams, new-mission selection and focused regression coverage.

## 任务列表

- [ ] 1. Inspect existing Team save/create/apply, AO read/update and canvas callers; run pre-edit GitNexus impact and confirm current callers where the index is stale.
- [ ] 2. Add failing regressions for independent named teams, default persistence, exact selected-team creation and mission isolation.
- [ ] 3. Extend the team store and headless AO bridge with compatible named-team/default support.
- [ ] 4. Add Runtime navigation and the reusable board-style team surface; connect new-mission team selection and keep mission edits scoped to their own team.
- [ ] 5. Verify Rust/Node regressions, TypeScript and rendered desktop/compact interactions. Preserve unrelated changes, keep deployment/publication scoped and preserve healthy missions, and clean task-owned temporary artifacts.
- [ ] 6. Review only the task diff, record verification evidence and converge the delivery checkpoint.

## 需求覆盖矩阵
| Requirement | Tasks | Verification |
|---|---|---|
| FR-1 | 1, 4, 5 | Rendered canvas and role editor |
| FR-2 | 2, 3, 4, 5 | Team persistence/default tests |
| FR-3 | 2, 3, 4, 5 | Exact team selection tests |
| FR-4 | 2, 3, 4, 5 | Snapshot and apply isolation tests |
| FR-5 | 7, 8, 9 | Retry cap, healthy-sibling and failed-review regressions |
| FR-6 | 7, 8, 9 | Deferred startup and immediate chat UI regressions |
| FR-7 | 7, 8, 9 | Slow-observation concurrent sibling regression |
| FR-8 | 7, 8, 9 | Current-thread streaming and slow-sibling activity regressions |

- [x] 7. Implement approved Retry/Failed contract, safe retry controls, failure handoff, deferred startup, ready-sibling scheduling and live role details.
- [x] 8. Verify Node red-green regressions, TypeScript, headless and Tauri test-target metadata, and browser team/default/alternate/compact behavior.
- [ ] 9. Complete final review, linked runtime tests/build, matching app deployment and scoped GitHub publication. Build storage and concurrent-source coordination decisions are pending.

## 文件变更清单
The scoped production files are listed in design.md. Existing AO test files are extended for regressions. Temporary verification/build assets live only under aiTemp/orchestrator-teams/.
