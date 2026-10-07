# 需求文档：one-click-codex-keysmith
## 功能概述
在现有 Electron Coding Tools Setup 页面增加一键安装官方 Keysmith v0.6.0 内置指令，复用受管安装、备份和卸载流程。
## 历史经验与坑
暂无适用历史资产。当前源码已打包官方单文件脚本；保留 hooks 的部署参数为 --skip-hooks-isolation。
## 术语定义
Keysmith：Jia-Ethan/codex-keysmith 指令部署工具。受管安装：manifest 的 md.path 为 coding-tools-keysmith.md。
## 范围边界
In Scope：内置指令一键安装、可选预览、自选 Markdown、安装后状态校验、可恢复卸载、加载失败和重复状态请求。
Out of Scope：发布、改动 Codex 账号凭据、自动修改本机真实全局指令、移动 Git 数据。
## 需求列表
### FR-1: 一键安装内置指令
优先级 Must。用户故事：作为应用用户，我想点击安装即可启用内置指令。
WHEN 用户在主窗口点击安装 THEN 系统 SHALL 先 dry-run 再应用经过校验的官方内置指令并检查 active 状态。
IF dry-run 或安装失败 THEN 系统 SHALL 显示错误并允许重试。
### FR-2: 保留现有自选文件与恢复功能
优先级 Must。用户故事：作为已有用户，我想继续使用自选 Markdown 并恢复安装前配置。
WHEN 用户选择文件并预览 THEN 系统 SHALL 保留内容与配置变化校验。
WHEN 用户预览并确认卸载 THEN 系统 SHALL 恢复之前指令配置且保持 hooks 和其他设置。
### FR-3: 状态明确且并发可用
优先级 Must。用户故事：作为用户，我想立即知道安装状态或失败原因。
IF 状态请求失败 THEN 系统 SHALL 离开 Loading 状态并显示失败。
WHILE 多处同时查询状态 THEN 系统 SHALL 共享未完成的状态请求。
## 非功能需求
NFR-1：复用已有 90 秒子进程超时与 128 KiB 输出限制。
NFR-2：保留 SHA256 固定脚本验证、焦点窗口校验、无 shell 执行、hooks 不隔离及原有文件校验。
NFR-3：开发和打包模式均使用已打包 v0.6.0；英中日文按钮一致。
## 依赖关系
现有 Python 3.10+、Electron preload/main IPC、KeysmithSetupPanel 与 i18n。
## 检查清单
- [x] FR-1、FR-2、FR-3 均有可测验收标准。
- [x] 范围和依赖明确。
