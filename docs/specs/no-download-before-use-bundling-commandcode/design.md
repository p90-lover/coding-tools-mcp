# 设计文档：no-download-before-use-bundling-commandcode

## 概述

把 commandcode-proxy、paseo、anneal 从运行时 `git-source` 改为 `bundled-source`：payload 随 Desktop 分发，Start 只做本地复制与进程拉起。CPA/Router 不改。覆盖 FR-1、FR-2、FR-3、FR-4、NFR-1、NFR-2、NFR-3。

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| 安装策略 | `bundled-source` | 明确禁止运行时 git clone | FR-1, FR-2 |
| CommandCode 载体 | git 提交 `vendor/bundled/commandcode-proxy` | 零 npm 依赖，体积小 | FR-1 |
| Paseo/Anneal 载体 | 打包期 GitHub tarball → extraResources | 避免 30MB+ 源码进 git | FR-2 |
| UI 闸门 | 隐藏三者 Install/Repair；Anneal token 可选 | 满足 no-download-before-use | FR-3 |
| 保活/原版功能 | 不改既有 Electron Check/Copy/Apply 与 RPC allowlist | 避免回归 #193 独特增量 | FR-4 |

### 架构设计

```
Desktop app (asar + extraResources)
  vendor/managed-components/{id}.json   strategy=bundled-source
  vendor/bundled/commandcode-proxy/     committed proxy.mjs
  resources/bundled-components/{id}/    package-time copy/fetch

Start / install
  bundledSourceHome() resolves:
    CODING_TOOLS_BUNDLED_COMPONENTS
    process.resourcesPath/bundled-components
    desktop-electron/vendor/bundled
    build/package-resources/bundled-components
  copyBundledTree → managed home → write marker → spawn launch.processes
```

---

## 数据模型

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| manifest.strategy | string | `bundled-source` | 三者专用 |
| manifest.commit | 40 hex | 必填 | 与上游 pin 一致 |
| manifest.bundle.entrypoint | posix 相对路径 | 必填 | 例如 `proxy.mjs` / `package.json` |
| marker.strategy | string | 与 manifest 一致 | `.coding-tools-managed-component.json` |
| credentials.githubReadToken.required | boolean | false | 不挡 Start |

不新增使用者 profile 字段。`autoStart` 默认保持 false。

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| bundledSourceHome | `bundledSourceHome(manifest, bundledRoot, env)` | manifest + 可选根 | 绝对路径或 null | FR-1, FR-2 |
| copyBundledTree | `copyBundledTree(source, dest)` | 两绝对路径 | void；跳过 `.git`/`node_modules`/symlink | FR-1 |
| prepareBundledSource | controller 内部 | manifest, stagingHome | `{ artifact: "" }` | FR-1, FR-2 |
| startComponent | 既有 IPC `startExternalService` | serviceId | snapshot | FR-3：未安装时自动 copy |
| installComponent | 对 bundled 仍可用，UI 不露出 | serviceId | snapshot | 供 bootstrap 复制 |

---

## 文件结构

```
desktop-electron/
├── electron/managed-components.cjs          策略、复制、Start 自动激活
├── electron/managed-external-services.cjs   Start 对 bundled 自动 install
├── vendor/managed-components/{commandcode-proxy,paseo,anneal}.json
├── vendor/bundled/commandcode-proxy/        真实上游
├── vendor/bundled/paseo/BUNDLE.json
├── vendor/bundled/anneal/BUNDLE.json
├── scripts/vendor-upstream-bundles.cjs      打包期物化
├── scripts/prepare-package-resources.cjs    写入 extraResources
├── package.json                             files 含 vendor/bundled/**
├── src/types.ts                             strategy 联合类型
├── src/features/ExternalServicesSurface.tsx 隐藏三者 Install 闸门
├── src/features/UpstreamToolSurface.tsx     去掉 download/install 文案
└── tests/bundled-components.test.cjs
```

---

## 设计决策

### 决策 1: 不把 Paseo/Anneal 完整树提交进 git（关联需求: FR-2, NFR-1）

**问题**: 完整 tarball 约 30MB，会污染主仓与 PR diff。

**选项**:
1. 全部提交进 `vendor/bundled`
2. 打包期下载 pinned tarball 到 extraResources，git 只留 BUNDLE.json + CommandCode

**决策**: 选择 2

**理由**: 使用者拿到的仍是已捆绑 Desktop；开发仓保持可审。缺失 payload 时报 Desktop build 错误，而不是引导去下载独立 App。

### 决策 2: Start 自动 copy，UI 隐藏 Install（关联需求: FR-3）

**问题**: 现有 `start()` 仅在 `installState === "installed"` 时拉起 managed 进程。

**选项**:
1. 强制使用者先点 Install（违反 owner 硬性要求）
2. bundled-source 的 Start/bootstrap 自动 `installComponent`（本地复制）

**决策**: 选择 2

**理由**: 复制不是「下载 App」。CPA/Router 仍走显式 Install。

### 决策 3: Anneal token 改为可选（关联需求: FR-3）

**问题**: `required: true` 让 bootstrap 在缺 token 时 blocked。

**选项**:
1. 继续必填
2. `required: false`，`{secret:githubReadToken}` 允许空，setup 优先复用已有 `.env`

**决策**: 选择 2

**理由**: token 不是克隆 Anneal 的前提。Docker/Postgres 失败应报主机 infra 错误。

---

## 测试策略

- `assertSafeManifest` 接受 `bundled-source` 并拒绝未 pin commit。
- 用临时 bundled root 复制 CommandCode 风格 fixture，断言无 `git clone`。
- Start 在 not-installed 时自动 copy 后 spawn。
- Anneal 缺 token 时 `missingCredentials` 为空。
- 合约测试：三者 strategy=`bundled-source`；CPA/Router 仍为既有策略。
- UI 合约：Install/Repair 字串仍存在（CPA/Router），但 bundled 面板走 `is-bundled` 分支。

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| unpackaged `electron .` 没有 Paseo/Anneal extraResources | 中 | 报 payload missing；开发者跑 `prepare-package-resources` 且 `fetchBundles` |
| 首次 Paseo/Anneal 仍可能 `npm ci` | 中 | `skipIfExists: node_modules`；PR 诚实说明仍属本地激活而非下载 App |
| GitHub 打包期 fetch 失败 | 中 | 打包失败并保留 staging 到 Trash |
| 误改 CPA/Router | 高 | 测试锁定其 strategy 与 Install UI |

---

## 检查清单

- [x] 技术方案与现有 managed-components 架构一致
- [x] requirements.md 中每条 FR 都被本设计覆盖
- [x] 文件结构对照真实代码库
- [x] 数据模型 / 接口契约清晰
- [x] 关键设计决策已记录并关联需求
- [x] 测试策略可验证验收标准
