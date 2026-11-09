# Command watch continuation

## 原则
A promise to check later must be backed by a registered watch or wake-up. Connect a known command's completion to a real next turn without model polling or command replay.

## 子规格索引
| Subspec | Requirements | Dependency |
| --- | --- | --- |
| [terminal-watch](subspecs/terminal-watch/spec.md) | FR-1, FR-2, FR-3 | None |
| [continuation](subspecs/continuation/spec.md) | FR-4, FR-5, FR-6 | terminal-watch |

## 依赖关系
See spec-manifest.json; continuation depends on terminal-watch.

## 里程碑
Contracts, bounded observation, completion delivery, race/cancellation regressions, scoped PR.
