# 设计文档：one-click-codex-keysmith
## 概述
覆盖 FR-1、FR-2、FR-3、NFR-1、NFR-2、NFR-3；复用现有受管 Keysmith 部署链。
## 技术方案
### 技术选型
使用现有 Node/Electron、React 和官方已固定的 Python 脚本，不增加依赖。
### 架构设计
Install 按钮 → preload keysmithInstall → focused main-window IPC → preview(undefined) → apply(confirmed) → status。
不传 --file 时使用官方内置稿；保留 --name coding-tools-keysmith 和 --skip-hooks-isolation。
预览指令缺省时以固定脚本摘要作为预览标识；自选文件继续使用文件摘要。
## 数据模型
复用 KeysmithCommandResult；增加可选 keysmithInstall API 以支持旧 preload。
## API 设计
keysmithInstall(): Promise<KeysmithCommandResult>：主窗口发起一次安装并返回验证后的状态。
preview(instructionFile?)：缺省使用内置指令。apply 的缺省路径仅匹配已成功预览的内置指令。
keysmithPreview(useBundled?: boolean)：显式选择内置预览时清除旧的自选文件，避免面板重新打开后继续预览不可见的文件。
状态 IPC 缓存未完成的 Promise，完成后清除。
## 文件结构
Electron 子项目位于 desktop-electron/，项目根目录为 G:/Projects/coding-tools-mcp。
修改 electron/keysmith-managed.cjs、electron/keysmith-ipc.cjs、electron/preload.cjs、src/types.ts、src/features/KeysmithSetupPanel.tsx、src/i18n.ts。
扩展 tests/keysmith-managed.test.cjs 与 tests/keysmith-ipc.test.cjs。
## 设计决策
选择官方脚本的内置稿（FR-1），无需再复制提示词或新增下载逻辑。
一键安装按钮本身授权安装，原自选文件和卸载仍保留 native confirmation（FR-2）。
缺省预览继续验证 config 摘要，不能将已有自选文件预览用于内置安装（NFR-2）。
## 测试策略
FR-1：真实隔离 Codex home 执行内置预览、安装、状态和卸载，验证原有指令及 hooks 恢复。
FR-2：保留现有自选文件、变更检测和卸载测试。
FR-3：IPC 并发状态测试及渲染失败状态验证。
运行现有三个 Keysmith Node 测试文件、TypeScript 检查和 renderer 构建。
## 风险评估
全局配置写入风险：仅指定 Codex home，dry-run 和恢复清单保护。
状态一致性风险：并发状态查询共享未完成请求；面板重新打开后通过显式内置预览标记清除旧文件选择。
## 检查清单
- [x] 全部 FR 有实现和测试对应；复用现有架构和打包资源。
