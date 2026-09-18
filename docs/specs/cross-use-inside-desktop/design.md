# 设计文档：cross-use-inside-desktop

## 概述

在 Desktop 内建立一份 loopback mesh，并在 managed Start 与 MCP runtime env 中注入，使 CommandCode/Paseo/Anneal 互相可见，并被 Router/CPA/MCP 以同一组 URL 调用。覆盖 FR-1、FR-2、FR-3、NFR-1、NFR-2、NFR-3。

---

## 技术方案

### 技术选型

| 类别 | 选择 | 理由 | 关联需求 |
|------|------|------|----------|
| 目录格式 | `loopback-mesh.json` schema 1 | 文件可被 MCP/子进程读取，不含密钥 | FR-1 |
| 注入点 | managed `commandSpec` env 合并 + 既有 `runtimeEnvironment` | 子进程与 MCP 各吃一份 | FR-2, FR-3 |
| Paseo/Anneal LLM 别名 | 仅对这两人设置 `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL` | 原版进程认这些变量；避免劫持 CPA/Router | FR-2 |
| MCP 发现 | 补齐 namespaced env；runtime-web `resolveCommandCodeLoopback` | 不改 Router 转发协议 | FR-3 |

### 架构设计

```
snapshot.services (loopback endpoints)
        |
        v
 buildLoopbackMesh()  -->  dataRoot/loopback-mesh.json  (URLs only)
        |
        +--> runtimeEnvironment() --> MCP / runtime-supervisor
        |
        +--> peerEnvironment(id) --> managed spawn env
               Paseo/Anneal also get OPENAI_BASE_URL -> CommandCode /v1
```

---

## 数据模型

| 实体/字段 | 类型 | 约束 | 说明 |
|-----------|------|------|------|
| mesh.schemaVersion | number | 1 | |
| mesh.managedBy | string | `Coding Tools` | |
| mesh.loopbackOnly | boolean | true | |
| mesh.services[id].url | string | loopback HTTP | origin |
| mesh.services[id].executionUrl | string or null | loopback HTTP/WS | Paseo/Anneal |
| mesh.services[id].openaiBaseUrl | string or null | CommandCode `/v1` | |
| env CODING_TOOLS_LOOPBACK_MESH | path | 绝对路径 | 指向 json |

不把 `proxyApiKey` 写入 mesh。`CODING_TOOLS_COMMANDCODE_API_KEY` 仅出现在 Paseo/Anneal 子进程 env。

---

## API 设计

| 方法/函数 | 路径/签名 | 入参 | 出参 | 关联需求 |
|-----------|-----------|------|------|----------|
| buildLoopbackMesh | `buildLoopbackMesh(services)` | snapshot services | mesh 对象 | FR-1 |
| loopbackMeshEnvironment | `loopbackMeshEnvironment(mesh, { targetId, commandCodeApiKey, meshPath })` | mesh + 目标 | env 字典 | FR-2, FR-3 |
| runtimeEnvironment | 既有，扩展键 | 无 | 含 PASEO_URL/ANNEAL_URL 与 CommandCode /v1 | FR-3 |
| resolveCommandCodeLoopback | runtime-web | env | provider profile or undefined | FR-3 |

---

## 文件结构

```
desktop-electron/electron/loopback-mesh.cjs
desktop-electron/electron/managed-components.cjs
desktop-electron/electron/managed-external-services.cjs
desktop-electron/electron/external-services.cjs
runtime-web/src/routed-providers.ts
desktop-electron/tests/loopback-mesh.test.cjs
runtime-web/tests/routed-providers.test.ts
docs/specs/cross-use-inside-desktop/*.md
```

---

## 设计决策

### 决策 1: 不给 CPA/Router/MCP 设置 OPENAI_BASE_URL（关联需求: FR-2, FR-3）

**问题**: 全局 `OPENAI_BASE_URL` 会把 ChatGPT Web harness 和 CPA 指到 CommandCode。

**选项**:
1. 全局注入
2. 只给 Paseo/Anneal 设 OpenAI/Anthropic 别名，其余只用 `CODING_TOOLS_*`

**决策**: 选择 2

**理由**: 满足互相调用，且不碰撞 #190 与 MCP Codex 路径。

### 决策 2: mesh 文件不含密钥（关联需求: NFR-2）

**问题**: 子进程与 MCP 都需要发现 URL。

**选项**:
1. 把 key 写进 json
2. URL 进 json；CommandCode bearer 只进 Paseo/Anneal env

**决策**: 选择 2

---

## 测试策略

- mesh 含五栈 loopback，JSON 无 key。
- Start CommandCode 的 spawn env 含 Paseo/Anneal/CPA/Router URL。
- Start Paseo 的 spawn env 含 `OPENAI_BASE_URL=http://127.0.0.1:9090/v1`。
- `runtimeEnvironment()` 含 `CODING_TOOLS_PASEO_URL` 与 `CODING_TOOLS_ANNEAL_URL`。
- runtime-web 从 env 解析 CommandCode loopback，拒绝非 loopback。
- 断言 `provider-network.cjs` keep-alive 常量未被本提交改写（测试读源码或 git 不要求）。

---

## 风险评估

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| OPENAI_BASE_URL 覆盖 Paseo 自带 provider | 中 | 仅注入别名；原版仍可读自己的 config |
| mesh 与使用者手动 endpoint 漂移 | 低 | overlay snapshot 的 loopback endpoint |
| 误改 CPA keep-alive | 高 | 不编辑该轮询实现 |

---

## 检查清单

- [x] 技术方案与现有 managed/runtime env 架构一致
- [x] 每条 FR 被覆盖
- [x] 文件结构真实
- [x] 数据模型清晰
- [x] 设计决策已记录
- [x] 测试策略可验证验收标准
