"use strict";

const crypto = require("node:crypto");

const MAX_BYTES = 2 * 1024 * 1024;
const ACTION_TIMEOUT_MS = 12_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const ALLOWED_PASEO = Object.freeze([
  "send_agent_message_request",
  "resume_agent_request",
  "cancel_agent_request",
  "archive_agent_request",
  "agent_permission_response",
  "create_agent_request",
]);
const ALLOWED_ANNEAL_POST = Object.freeze([
  "/projects/{id}/tasks",
  "/tasks/{id}/start",
  "/tasks/{id}/retry",
  "/tasks/{id}/archive",
  "/tasks/{id}/unarchive",
  "/tasks/{id}/chain/hold",
  "/tasks/{id}/chain/resume",
  "/inbox/messages/{id}/decision",
  "/inbox/messages/{id}/reply",
  "/inbox/messages/{id}/close",
]);
const ALLOWED_ANNEAL_GET = Object.freeze([
  "/projects",
  "/tasks",
  "/tasks/{id}",
  "/tasks/{id}/activity",
]);
const ALLOWED_ANNEAL_PATCH = Object.freeze(["/tasks/{id}"]);

function token(value, label) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > 200) throw new Error(`${label} is required`);
  if (![...trimmed].every((char) => /[A-Za-z0-9_.:-]/u.test(char))) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return trimmed;
}

function boundedText(value, max, label) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`${label} is required`);
  if (trimmed.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(trimmed)) {
    throw new Error(`${label} is too long or contains control characters`);
  }
  return trimmed;
}

function requestId(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed.slice(0, 200) : crypto.randomUUID();
}

function assertLoopback(raw, protocols, label) {
  let parsed;
  try {
    parsed = new URL(String(raw || ""));
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (!protocols.has(parsed.protocol)) {
    throw new Error(`${label} uses an unsupported protocol`);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(`${label} is restricted to loopback hosts`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  return parsed;
}

function paseoOpName(op) {
  switch (String(op || "").trim()) {
    case "send":
      return "send_agent_message_request";
    case "resume":
      return "resume_agent_request";
    case "cancel":
      return "cancel_agent_request";
    case "archive":
      return "archive_agent_request";
    case "permission":
      return "agent_permission_response";
    case "create":
      return "create_agent_request";
    default:
      return String(op || "").trim();
  }
}

function buildPaseoMessage(req) {
  const op = paseoOpName(req.op);
  if (!ALLOWED_PASEO.includes(op)) {
    throw new Error("Paseo operation is not in the original-function allowlist");
  }
  const rid = requestId(req.requestId || req.request_id);
  switch (op) {
    case "send_agent_message_request":
      return {
        type: op,
        requestId: rid,
        agentId: token(req.agentId || req.agent_id, "agent id"),
        text: boundedText(req.text, 8192, "message"),
      };
    case "resume_agent_request":
      return {
        type: op,
        requestId: rid,
        handle: {
          provider: token(req.provider, "provider"),
          sessionId: token(req.sessionId || req.session_id, "session id"),
        },
      };
    case "cancel_agent_request":
    case "archive_agent_request":
      return {
        type: op,
        requestId: rid,
        agentId: token(req.agentId || req.agent_id, "agent id"),
      };
    case "agent_permission_response": {
      const behavior = String(req.behavior || "").trim();
      if (behavior !== "allow" && behavior !== "deny") {
        throw new Error("Permission behavior must be allow or deny");
      }
      return {
        type: op,
        agentId: token(req.agentId || req.agent_id, "agent id"),
        requestId: token(req.requestId || req.request_id, "permission request id"),
        response: { behavior },
      };
    }
    case "create_agent_request":
      return {
        type: op,
        requestId: rid,
        config: {
          provider: token(req.provider, "provider"),
          cwd: boundedText(req.cwd, 1024, "cwd"),
        },
        initialPrompt: boundedText(req.text, 8192, "prompt"),
      };
    default:
      throw new Error("Paseo operation is not in the original-function allowlist");
  }
}

function expectedPaseoResponse(op) {
  return {
    send_agent_message_request: "send_agent_message_response",
    resume_agent_request: "resume_agent_response",
    cancel_agent_request: "cancel_agent_response",
    archive_agent_request: "archive_agent_response",
    agent_permission_response: "agent_permission_resolved",
    create_agent_request: "create_agent_response",
  }[op] || "rpc_error";
}

function annealPathForOp(op, id, req = {}) {
  switch (String(op || "").trim()) {
    case "create": {
      const projectId = token(id || req.projectId || req.project_id, "project id");
      const name = boundedText(req.name || req.title || req.text || "Coding Tools handoff", 200, "task name");
      const description = boundedText(
        req.description || req.text || name,
        8000,
        "task description",
      );
      return {
        method: "POST",
        pattern: "/projects/{id}/tasks",
        path: `/projects/${projectId}/tasks`,
        body: {
          name,
          description,
          status: "BACKLOG",
          assigneeType: req.assigneeAgentId ? "AGENT" : "HUMAN",
          ...(req.assigneeAgentId ? { assigneeAgentId: token(req.assigneeAgentId, "agent id") } : {}),
          ...(req.repoId ? { repoId: token(req.repoId, "repository id") } : {}),
          ...(req.cwd ? { workingDirectory: boundedText(req.cwd, 1024, "working directory") } : {}),
          approvalGate: true,
          opensPullRequest: false,
          scheduleKind: "NOW",
        },
      };
    }
    case "preview": {
      const safeId = token(id, "task id");
      return { method: "GET", pattern: "/tasks/{id}", path: `/tasks/${safeId}`, body: null };
    }
    case "projects":
      return { method: "GET", pattern: "/projects", path: "/projects", body: null };
    case "board": {
      const query = new URLSearchParams({ view: "board", archived: "false" });
      if (req.projectId || req.project_id) query.set("projectId", token(req.projectId || req.project_id, "project id"));
      return { method: "GET", pattern: "/tasks", path: `/tasks?${query}`, body: null };
    }
    case "update": {
      const safeId = token(id, "task id");
      if (!["BACKLOG", "TODO", "DOING", "REVIEW", "DONE"].includes(req.status)) {
        throw new Error("Unsupported Anneal task status");
      }
      // The API checks the current task's move authority transactionally.
      return { method: "PATCH", pattern: "/tasks/{id}", path: `/tasks/${safeId}`, body: { status: req.status } };
    }
    case "activity": {
      const safeId = token(id, "task id");
      return { method: "GET", pattern: "/tasks/{id}/activity", path: `/tasks/${safeId}/activity`, body: null };
    }
    case "start": {
      const safeId = token(id, "id");
      return { method: "POST", pattern: "/tasks/{id}/start", path: `/tasks/${safeId}/start`, body: {} };
    }
    case "retry": {
      const safeId = token(id, "id");
      return { method: "POST", pattern: "/tasks/{id}/retry", path: `/tasks/${safeId}/retry`, body: {} };
    }
    case "archive": {
      const safeId = token(id, "id");
      return { method: "POST", pattern: "/tasks/{id}/archive", path: `/tasks/${safeId}/archive`, body: {} };
    }
    case "unarchive": {
      const safeId = token(id, "id");
      return { method: "POST", pattern: "/tasks/{id}/unarchive", path: `/tasks/${safeId}/unarchive`, body: {} };
    }
    case "hold": {
      const safeId = token(id, "id");
      return {
        method: "POST",
        pattern: "/tasks/{id}/chain/hold",
        path: `/tasks/${safeId}/chain/hold`,
        body: { requestId: crypto.randomUUID() },
      };
    }
    case "resume": {
      const safeId = token(id, "id");
      return {
        method: "POST",
        pattern: "/tasks/{id}/chain/resume",
        path: `/tasks/${safeId}/chain/resume`,
        body: { requestId: crypto.randomUUID() },
      };
    }
    case "inbox_decision": {
      const safeId = token(id, "id");
      return {
        method: "POST",
        pattern: "/inbox/messages/{id}/decision",
        path: `/inbox/messages/${safeId}/decision`,
        body: { decision: "approve", requestId: crypto.randomUUID() },
      };
    }
    case "inbox_reply": {
      const safeId = token(id, "id");
      return {
        method: "POST",
        pattern: "/inbox/messages/{id}/reply",
        path: `/inbox/messages/${safeId}/reply`,
        body: { body: "", requestId: crypto.randomUUID() },
      };
    }
    case "inbox_close": {
      const safeId = token(id, "id");
      return {
        method: "POST",
        pattern: "/inbox/messages/{id}/close",
        path: `/inbox/messages/${safeId}/close`,
        body: { requestId: crypto.randomUUID() },
      };
    }
    default:
      throw new Error("Anneal operation is not in the original-function allowlist");
  }
}

function parseWsJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Paseo returned invalid JSON");
  }
}

async function paseoRpc(endpoint, credential, message, rid, expected, {
  timeoutMs = ACTION_TIMEOUT_MS,
  webSocketImpl = globalThis.WebSocket,
} = {}) {
  if (typeof webSocketImpl !== "function") {
    throw new Error("Paseo WebSocket client is unavailable");
  }
  const parsed = assertLoopback(endpoint, new Set(["ws:", "wss:"]), "Paseo execution endpoint");
  const tokenValue = typeof credential === "string" ? credential.trim() : "";
  if (tokenValue && ![...tokenValue].every((char) => /[A-Za-z0-9!#$%&'*+\-.^_`|~]/u.test(char))) {
    throw new Error("Paseo password must be valid WebSocket subprotocol token characters");
  }
  const protocols = tokenValue ? [`paseo.bearer.${tokenValue}`] : undefined;
  const ws = protocols
    ? new webSocketImpl(parsed.toString(), protocols)
    : new webSocketImpl(parsed.toString());
  const hello = {
    type: "hello",
    clientId: `coding-tools-actor-${crypto.randomUUID()}`,
    clientType: "cli",
    protocolVersion: 1,
    capabilities: {
      voice: false,
      pushNotifications: false,
      explicit_event_subscriptions: true,
      selective_agent_timeline: true,
      all_providers: true,
    },
  };

  return await new Promise((resolve, reject) => {
    let settled = false;
    let sent = false;
    let frames = 0;
    const timer = setTimeout(() => finish(new Error("Paseo action timed out")), timeoutMs);
    timer.unref?.();
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    ws.addEventListener?.("error", () => {
      finish(new Error("Paseo is not reachable. Check the daemon port; no agent was started."));
    });
    ws.addEventListener?.("close", () => {
      finish(new Error("Paseo closed the action connection"));
    });
    ws.addEventListener?.("open", () => {
      try {
        ws.send(JSON.stringify(hello));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Paseo handshake failed"));
      }
    });
    ws.addEventListener?.("message", (event) => {
      frames += 1;
      if (frames > 64) {
        finish(new Error("Paseo did not return a matching action response"));
        return;
      }
      const raw = typeof event.data === "string"
        ? event.data
        : Buffer.isBuffer(event.data)
          ? event.data.toString("utf8")
          : String(event.data || "");
      let payload;
      try {
        payload = parseWsJson(raw);
      } catch (error) {
        finish(error);
        return;
      }
      if (payload.type !== "session") return;
      const inner = payload.message || {};
      if (
        !sent
        && inner.payload?.status === "server_info"
        && typeof inner.payload?.serverId === "string"
      ) {
        try {
          ws.send(JSON.stringify({ type: "session", message }));
          sent = true;
        } catch (error) {
          finish(error instanceof Error ? error : new Error("Paseo action request failed"));
        }
        return;
      }
      if (sent && inner.type === "rpc_error" && inner.payload?.requestId === rid) {
        finish(null, {
          ok: false,
          op: message.type,
          detail: String(inner.payload?.message || "Paseo refused the request").slice(0, 300),
        });
        return;
      }
      if (
        sent
        && (
          inner.type === expected
          || inner.payload?.requestId === rid
          || (expected === "agent_permission_resolved" && inner.type === "agent_permission_resolved")
        )
      ) {
        finish(null, { ok: true, op: message.type, detail: `${expected} received` });
      }
    });
  });
}

async function annealRequest(endpoint, credential, {
  method = "GET",
  path,
  body = null,
  timeoutMs = ACTION_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Anneal HTTP client is unavailable");
  const base = assertLoopback(endpoint, new Set(["http:", "https:"]), "Anneal execution endpoint");
  base.pathname = `${base.pathname.replace(/\/+$/u, "")}/`;
  const parsed = new URL(String(path).replace(/^\//u, ""), base);
  if (parsed.origin !== base.origin) throw new Error("Anneal request must stay on its configured origin");
  parsed.hash = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(parsed.toString(), {
      method,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = typeof response.text === "function" ? await response.text() : "";
    if (text.length > MAX_BYTES) throw new Error("Anneal response exceeds the observation limit");
    if (!response.ok) {
      const snippet = String(text).replace(/[\u0000-\u001f]/gu, "").slice(0, 180);
      throw new Error(`Anneal returned HTTP ${response.status}. ${snippet}`.trim());
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: true, status: response.status, path, text, json };
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Anneal action timed out");
    throw error instanceof Error ? error : new Error("Anneal is not reachable; no runner was started.");
  } finally {
    clearTimeout(timer);
  }
}

async function annealPost(endpoint, credential, path, body, options = {}) {
  const result = await annealRequest(endpoint, credential, { ...options, method: "POST", path, body });
  return `HTTP ${result.status} at ${path}`;
}

async function actUpstream(input = {}, options = {}) {
  const toolId = String(input.toolId || input.source || "").trim();
  if (toolId === "paseo") {
    const message = buildPaseoMessage(input);
    return paseoRpc(
      input.endpoint,
      input.credential,
      message,
      message.requestId,
      expectedPaseoResponse(message.type),
      options,
    );
  }
  if (toolId === "anneal") {
    const id = String(input.op || "").startsWith("inbox_")
      ? (input.messageId || input.message_id)
      : (input.op === "create"
        ? (input.projectId || input.project_id)
        : (input.taskId || input.task_id));
    const spec = annealPathForOp(input.op, id, input);
    const method = spec.method || "POST";
    const allowed = method === "GET" ? ALLOWED_ANNEAL_GET
      : method === "PATCH" ? ALLOWED_ANNEAL_PATCH : ALLOWED_ANNEAL_POST;
    if (!allowed.includes(spec.pattern)) {
      throw new Error("Anneal operation is not in the original-function allowlist");
    }
    const body = spec.body && typeof spec.body === "object" ? { ...spec.body } : spec.body;
    if (input.op === "inbox_decision") body.decision = boundedText(input.text, 8000, "decision");
    if (input.op === "inbox_reply") body.body = boundedText(input.text, 8000, "reply");
    const result = await annealRequest(input.endpoint, input.credential, {
      ...options,
      method,
      path: spec.path,
      body: method === "GET" ? null : body,
    });
    return { ok: true, op: input.op, detail: `HTTP ${result.status} at ${spec.path}`, body: result.json };
  }
  throw new Error("Unknown integration source");
}

module.exports = {
  ACTION_TIMEOUT_MS,
  ALLOWED_ANNEAL_GET,
  ALLOWED_ANNEAL_PATCH,
  ALLOWED_ANNEAL_POST,
  ALLOWED_PASEO,
  actUpstream,
  annealPathForOp,
  annealPost,
  annealRequest,
  buildPaseoMessage,
};
