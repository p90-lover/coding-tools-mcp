# 任务清单：one-click-codex-keysmith
## 概述
复用现有安装器，只补一键入口与状态修复。
## 交付物清单（Scope-lock）
预计新建文件数：3 个规格文档和 .gitattributes。预计修改文件数：8 个源代码及测试文件。预计新增/修改函数数：6 个。
交付物：requirements.md、design.md、本文件；electron/keysmith-managed.cjs、electron/keysmith-ipc.cjs、electron/preload.cjs、src/types.ts、src/features/KeysmithSetupPanel.tsx、src/i18n.ts、tests/keysmith-managed.test.cjs、tests/keysmith-ipc.test.cjs。
## 任务列表
### 阶段 1: 复用与验证
- [x] 1.1 扩展现有测试验证内置指令真实安装恢复和并发状态请求。
  - 证据块：tests/keysmith-managed.test.cjs:210 已有隔离安装/卸载测试；keysmith-ipc.test.cjs:34 注册 IPC 测试。
  - 涉及文件：两个测试文件，各新增不超过 110 行。
  - 需求: FR-1, FR-2, FR-3；设计: 测试策略。
### 阶段 2: 核心实现
- [x] 2.1 允许内置稿预览应用，并增加焦点主窗口的一键安装 IPC 和状态共享。
  - 证据块：electron/keysmith-managed.cjs:152 的 deployArgs 强制 --file；keysmith-ipc.cjs:40 直接调用 status。
  - 涉及文件：managed 与 IPC 各新增不超过 50 行，preload 与 types 各 1 行。
  - 需求: FR-1, FR-2, FR-3；设计: API 设计。
- [x] 2.2 添加安装按钮与英中日文文案，失败状态不再显示 Loading。
  - 证据块：src/features/KeysmithSetupPanel.tsx:34 的 catch 只设置 error；:61 的按钮仅选文件。
  - 涉及文件：Panel 新增不超过 35 行、i18n 新增不超过 15 行。
  - 需求: FR-1, FR-3；设计: 架构设计。
### 阶段 3: 集成测试
- [x] 3.1 对照验收标准核验真实内置安装恢复、现有三组测试、类型检查、构建与 UI。
  - 证据块：tests/keysmith-package.test.cjs:9 已验证资源与 release 摘要；package.json:13 有 typecheck。
  - 涉及文件：不新增测试工具；临时构建在 aiTemp。
  - 需求: FR-1, FR-2, FR-3；设计: 测试策略。
## 检查点
- [x] 测试先复现缺少内置入口与并发冲突。
- [x] 安装、状态和恢复符合全部 FR。
- [x] 受影响测试与静态检查通过，临时产物清理。
## 需求覆盖矩阵
| 需求 ID | 设计章节 | 任务编号 | 状态 |
|---|---|---|---|
| FR-1 | 架构设计 | 1.1, 2.1, 2.2, 3.1 | 已验证 |
| FR-2 | API 设计 | 1.1, 2.1, 3.1 | 已验证 |
| FR-3 | API 设计 | 1.1, 2.1, 2.2, 3.1 | 已验证 |
## 文件变更清单
上述 8 个现有文件精确修改；每个新增低于 110 行；不拆分已有大文件。
## 检查清单
- [x] 任务含需求回链、源码证据、文件及行数预算。
