const { createServer } = require("node:http");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Codex asks for its model catalog right at startup and gives up after about five seconds,
// often before the ChatGPT browser session is ready. The last good catalog per account is
// kept on disk and served when the live request is slow or fails; the live request still
// finishes in the background and refreshes it.
const MODELS_CACHE_WAIT_MS = 3_500;
const MODELS_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const { releaseRetainedConversation } = require("./retained-turn-release.cjs");

const MAX_BODY_BYTES = 16 * 1024;
const APP_READ_TOOLS = new Set(["apps_list", "apps_catalog", "apps_status"]);
const NATIVE_CODEX_TOOLS = new Set(["codex_runtime_status", "codex_agent_control", "codex_agent_read", "codex_command_exec"]);
const AGENT_ORCHESTRATOR_OPERATIONS = new Set(["inspect", "board", "models", "harnesses", "runs", "update_run", "harness_status", "connect_harness", "stop_harness", "observe", "advance", "start_run", "run_status", "approve_harness", "next", "create", "append", "move_task", "move_clause"]);
const MAX_MANUAL_START_BODY_BYTES = 3 * 1024 * 1024;
const MANUAL_SENT_OBSERVER_TIMEOUT_MS = 35_000;

function secureTokenMatches(expected, authorization) {
  const prefix = "Bearer ";
  if (typeof authorization !== "string" || !authorization.startsWith(prefix)) return false;
  const supplied = Buffer.from(authorization.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) throw new Error("request body is empty");
  return JSON.parse(text);
}

function writeJson(response, status, body) {
  const encoded = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(encoded.length),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(encoded);
}

function fetchNativeWithProxyAuth({ electronNet, browserSession, url, options, getProxyCredentials }) {
  return new Promise((resolve, reject) => {
    const headers = new Headers(options.headers);
    headers.delete("cookie");
    headers.delete("proxy-authorization");
    const request = electronNet.request({
      url, method: options.method, headers: Object.fromEntries(headers),
      session: browserSession, credentials: "omit", useSessionCookies: false,
      redirect: "manual",
    });
    const abort = () => request.abort();
    if (options.signal?.aborted) {
      abort();
      reject(options.signal.reason ?? new DOMException("Native fetch aborted", "AbortError"));
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    let proxyLoginAttempted = false;
    request.on("login", (authInfo, callback) => {
      let credentials = null;
      if (authInfo.isProxy && !proxyLoginAttempted) {
        proxyLoginAttempted = true;
        try { credentials = getProxyCredentials(authInfo); } catch {}
      }
      if (credentials?.username && credentials?.password) callback(credentials.username, credentials.password);
      else callback();
    });
    request.on("redirect", (status, _method, location, responseHeaders) => {
      try {
        const redirected = new Headers(responseHeaders);
        redirected.set("location", location);
        resolve(new Response(null, { status, headers: redirected }));
      } catch (error) { reject(error); }
      request.abort();
    });
    request.on("response", (incoming) => {
      try {
        const body = [204, 205, 304].includes(incoming.statusCode) ? null : Readable.toWeb(incoming);
        resolve(new Response(body, { status: incoming.statusCode, headers: incoming.headers }));
      } catch (error) { reject(error); }
    });
    request.on("error", reject);
    request.end(options.body);
  });
}

class BrowserControlServer {
  constructor({ logger, getBrowserHost, getPreferences, resolveProxy, fetchNative, getCodingToolsWorkspaces, callReadOnlyAppTool, callNativeCodexTool, callAgentOrchestrator, requestKeepBridgeQuit, onTurnEvent, modelsCacheDir = null, modelsCacheWaitMs = MODELS_CACHE_WAIT_MS }) {
    this.logger = logger;
    this.modelsCacheDir = modelsCacheDir;
    this.modelsCacheWaitMs = modelsCacheWaitMs;
    // Observes turn lifecycle and native network failures for MCP event incidents.
    this.onTurnEvent = onTurnEvent;
    this.getBrowserHost = getBrowserHost;
    this.getPreferences = getPreferences;
    this.resolveProxy = resolveProxy;
    this.fetchNative = fetchNative;
    this.getCodingToolsWorkspaces = getCodingToolsWorkspaces;
    this.callReadOnlyAppTool = callReadOnlyAppTool;
    this.callNativeCodexTool = callNativeCodexTool;
    this.callAgentOrchestrator = callAgentOrchestrator;
    // Lets a local tool (an installer or patch script) restart or quit the app the way the tray's
    // "Restart app (keep Codex bridge, MCP, CPA)" does, instead of killing it. It cannot stop the
    // bridge: the only quit it can request keeps the bridge, MCP tunnel and CPA running.
    this.requestKeepBridgeQuit = requestKeepBridgeQuit;
    this.token = randomBytes(32).toString("base64url");
    this.port = 0;
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error("browser.control_request_failed", { message });
        if (response.destroyed) return;
        if (response.headersSent) {
          response.destroy();
          return;
        }
        try {
          writeJson(response, 500, { error: "internal_error" });
        } catch {
          response.destroy();
        }
      });
    });
    this.server.on("error", (error) => {
      this.logger.error("browser.control_server_error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    this.server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        const address = this.server.address();
        this.port = address && typeof address === "object" ? address.port : 0;
        if (!this.port) reject(new Error("Browser control server did not receive a port"));
        else resolve();
      });
    });
    this.logger.info("browser.control_started", { port: this.port });
    return this;
  }

  reportTurnEvent(event) {
    if (!this.onTurnEvent) return;
    // An observer must never change the outcome of a turn request.
    try { this.onTurnEvent(event); } catch (error) {
      this.logger.debug?.("browser.turn_event_observer_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  descriptor() {
    if (!this.port) throw new Error("Browser control server is not started");
    return { endpoint: `http://127.0.0.1:${this.port}`, token: this.token };
  }

  async handle(request, response) {
    if (!secureTokenMatches(this.token, request.headers.authorization)) {
      writeJson(response, 401, { error: "unauthorized" });
      return;
    }
    const isTurn = request.url === "/v1/turn/start"
      || request.url === "/v1/turn/heartbeat"
      || request.url === "/v1/turn/end";
    const isTurnRelease = request.url === "/v1/turn/release";
    const isSessionInspect = request.url === "/v1/session/inspect";
    const isProxyResolution = request.url === "/v1/network/resolve-proxy";
    const isNativeFetch = request.url === "/v1/network/native-fetch";
    const isWorkspaceCatalog = request.url === "/v1/coding-tools/workspaces";
    const isAppRead = request.url === "/v1/coding-tools/apps";
    const isNativeCodex = request.url === "/v1/coding-tools/native-codex";
    const isAgentOrchestrator = request.url === "/v1/coding-tools/agent-orchestrator";
    const isLauncherQuit = request.url === "/v1/launcher/quit-keep-bridge";
    const manualAction = new Map([
      ["/v1/manual/start", "start"],
      ["/v1/manual/wait-sent", "wait-sent"],
      ["/v1/manual/wait-terminal", "wait-terminal"],
      ["/v1/manual/started", "started"],
      ["/v1/manual/end", "end"],
      ["/v1/manual/cancel", "cancel"],
    ]).get(request.url);
    if (request.method !== "POST" || (!isTurn && !isTurnRelease && !isSessionInspect && !isProxyResolution && !isNativeFetch && !isWorkspaceCatalog && !isAppRead && !isNativeCodex && !isAgentOrchestrator && !isLauncherQuit && !manualAction)) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    try {
      if (isNativeFetch) {
        await this.forwardNativeFetch(request, response);
        return;
      }
      const body = await readJson(
        request,
        manualAction === "start" ? MAX_MANUAL_START_BODY_BYTES : isNativeCodex ? 32 * 1024 : MAX_BODY_BYTES,
      );
      if (isWorkspaceCatalog) {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
          throw new Error("Workspace catalog takes no arguments");
        }
        if (!this.getCodingToolsWorkspaces) throw new Error("Workspace catalog is unavailable");
        writeJson(response, 200, await this.getCodingToolsWorkspaces());
        return;
      }
      if (isAppRead) {
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 1 || !APP_READ_TOOLS.has(body.tool)) {
          throw new Error("Only read-only module catalog tools are available");
        }
        if (!this.callReadOnlyAppTool) throw new Error("Module catalog is unavailable");
        writeJson(response, 200, await this.callReadOnlyAppTool(body.tool));
        return;
      }
      if (isLauncherQuit) {
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 1 || typeof body.relaunch !== "boolean") {
          throw new Error("Launcher quit takes only { relaunch: boolean }");
        }
        if (!this.requestKeepBridgeQuit) throw new Error("Launcher quit is unavailable");
        writeJson(response, 202, await this.requestKeepBridgeQuit({ relaunch: body.relaunch }));
        return;
      }
      if (isAgentOrchestrator) {
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 3
          || typeof body.workspace_id !== "string" || !body.workspace_id || body.workspace_id.length > 128
          || !AGENT_ORCHESTRATOR_OPERATIONS.has(body.operation)
          || !body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) {
          throw new Error("Invalid Agent Orchestrator request");
        }
        if (!this.callAgentOrchestrator) throw new Error("Agent Orchestrator is unavailable");
        writeJson(response, 200, await this.callAgentOrchestrator(body.operation, {
          ...body.arguments, workspaceId: body.workspace_id,
        }));
        return;
      }
      if (isNativeCodex) {
        if (!body || typeof body !== "object" || Array.isArray(body)
          || Object.keys(body).length !== 4
          || typeof body.workspace_id !== "string" || !body.workspace_id || body.workspace_id.length > 128
          || typeof body.request_id !== "string" || !/^[A-Za-z0-9_-]{6,128}$/.test(body.request_id)
          || !NATIVE_CODEX_TOOLS.has(body.tool)
          || !body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)
          || (["codex_agent_control", "codex_command_exec"].includes(body.tool)
            && body.arguments.request_id !== body.request_id)) {
          throw new Error("Invalid native Codex tool request");
        }
        if (!this.callNativeCodexTool) throw new Error("Native Codex tool bridge is unavailable");
        writeJson(response, 200, await this.callNativeCodexTool(body));
        return;
      }
      if (isProxyResolution) {
        const url = new URL(body?.url);
        if (url.origin !== "https://chatgpt.com" || url.username || url.password
          || !url.pathname.startsWith("/backend-api/codex/")) {
          throw new Error("Proxy resolution is restricted to native Codex requests");
        }
        if (!this.resolveProxy) throw new Error("Native proxy resolver is unavailable");
        let proxy;
        try { proxy = await this.resolveProxy(url.href); }
        catch { throw new Error("System proxy resolution failed"); }
        writeJson(response, 200, { proxy });
        return;
      }
      const preferences = this.getPreferences();
      const host = this.getBrowserHost();
      if (!host) throw new Error("browser host is not ready");
      if (isSessionInspect) {
        if (host.browserInteractionMode() === "manual") {
          const error = new Error(
            "ChatGPT session and capability inspection is disabled in Zero Risk mode",
          );
          error.code = "manual_browser_inspection_disabled";
          throw error;
        }
        const result = await host.inspectSession(body?.detectCapabilities === true);
        writeJson(response, 200, result);
        return;
      }
      if (isTurnRelease) {
        if (typeof body?.conversationKey !== "string" || !/^[a-f0-9]{64}$/.test(body.conversationKey)) {
          throw new Error("conversationKey is invalid");
        }
        const released = releaseRetainedConversation(host, body.conversationKey);
        this.logger.info("browser.retained_conversation_released", { released });
        writeJson(response, 200, { ok: true, released });
        return;
      }
      if (!body || typeof body !== "object" || !/^[A-Za-z0-9_-]{6,128}$/.test(body.traceId || "")) {
        throw new Error("traceId is invalid");
      }
      if (!Number.isInteger(body.helperPid) || body.helperPid < 1) {
        throw new Error("browser helper pid is invalid");
      }
      if (body.conversationKey !== undefined && !/^[a-f0-9]{64}$/.test(body.conversationKey)) {
        throw new Error("conversationKey is invalid");
      }
      if (body.connectorIdentity !== undefined
        && (typeof body.connectorIdentity !== "string"
          || !body.connectorIdentity.trim()
          || body.connectorIdentity.length > 80)) {
        throw new Error("connectorIdentity is invalid");
      }
      if (body.requireRetainedConversation !== undefined
        && typeof body.requireRetainedConversation !== "boolean") {
        throw new Error("requireRetainedConversation is invalid");
      }
      if (body.requireRetainedConversation === true && body.conversationKey === undefined) {
        throw new Error("requireRetainedConversation requires conversationKey");
      }
      if (body.connectorIdentity !== undefined && body.conversationKey === undefined) {
        throw new Error("connectorIdentity requires conversationKey");
      }
      if (body.retain !== undefined && typeof body.retain !== "boolean") {
        throw new Error("retain is invalid");
      }
      if (body.connectorBound !== undefined && typeof body.connectorBound !== "boolean") {
        throw new Error("connectorBound is invalid");
      }
      if (body.refreshViewport !== undefined && typeof body.refreshViewport !== "boolean") {
        throw new Error("refreshViewport is invalid");
      }
      if (body.refreshViewport !== undefined && request.url !== "/v1/turn/heartbeat") {
        throw new Error("refreshViewport is only valid for a turn heartbeat");
      }
      if (manualAction) {
        if (manualAction === "start") {
          if (host.browserInteractionMode() !== "manual") {
            throw new Error("Zero Risk is not enabled");
          }
          if (typeof body.prompt !== "string" || body.prompt.length < 1) {
            throw new Error("manual prompt is invalid");
          }
          if (body.resumePrompt !== undefined
            && (typeof body.resumePrompt !== "string" || body.resumePrompt.length < 1)) {
            throw new Error("manual resume prompt is invalid");
          }
          if (body.compaction !== undefined && body.compaction !== true) {
            throw new Error("manual compaction flag is invalid");
          }
          const lease = host.beginManualTurn(
            body.traceId,
            body.helperPid,
            body.prompt,
            body.conversationKey,
            body.resumePrompt,
            body.compaction === true,
          );
          this.logger.info("browser.manual_control_started", {
            traceId: body.traceId,
            reused: lease.reused,
          });
          this.reportTurnEvent({ type: "start", traceId: body.traceId, conversationKey: body.conversationKey, manual: true });
          writeJson(response, 200, { ok: true, ...lease });
          return;
        }
        if (manualAction === "wait-sent") {
          const observed = await host.waitManualSent(
            body.traceId,
            body.helperPid,
            MANUAL_SENT_OBSERVER_TIMEOUT_MS,
          );
          if (observed.status === "pending") {
            writeJson(response, 202, { ok: true, status: "pending" });
            return;
          }
          if (observed.status === "timeout") {
            writeJson(response, 408, { error: "Manual prompt was not confirmed within its allowed time", code: "manual_turn_timed_out" });
            return;
          }
          if (observed.status === "cancelled") {
            writeJson(response, 409, { error: "Zero Risk turn was cancelled", code: "turn_cancelled" });
            return;
          }
          if (observed.status !== "sent") {
            writeJson(response, 409, { error: "Zero Risk turn failed before Sent confirmation", code: "manual_turn_failed" });
            return;
          }
          writeJson(response, 200, { ok: true, status: "sent", sentAt: observed.sentAt });
          return;
        }
        if (manualAction === "wait-terminal") {
          const observed = await host.waitManualTerminal(
            body.traceId,
            body.helperPid,
            MANUAL_SENT_OBSERVER_TIMEOUT_MS,
          );
          if (observed.status === "pending") {
            writeJson(response, 202, { ok: true, status: "pending" });
            return;
          }
          if (observed.status === "timeout") {
            writeJson(response, 408, {
              error: "Codex Zero Risk did not start within its allowed time after Sent confirmation",
              code: "manual_turn_timed_out",
            });
            return;
          }
          if (!['cancelled', 'failed'].includes(observed.status)) {
            throw new Error("manual terminal state is invalid");
          }
          writeJson(response, 200, { ok: true, status: observed.status });
          return;
        }
        if (manualAction === "started") {
          host.markManualTurnStarted(body.traceId, body.helperPid);
          writeJson(response, 200, { ok: true });
          return;
        }
        if (manualAction === "cancel") {
          const result = host.cancelManualTurn(body.traceId, body.helperPid);
          writeJson(response, 200, { ok: true, ...result });
          return;
        }
        if (!['completed', 'failed', 'aborted'].includes(body.status)) {
          throw new Error("manual turn status is invalid");
        }
        this.reportTurnEvent({ type: "end", traceId: body.traceId, status: body.status, conversationKey: body.conversationKey, manual: true });
        const release = host.endManualTurn(
          body.traceId,
          body.helperPid,
          body.status,
          body.retain === true,
        );
        writeJson(response, 200, { ok: true, ...release });
        return;
      }
      if (request.url === "/v1/turn/start") {
        if (host.browserInteractionMode() === "manual") {
          throw new Error("Automatic browser interaction is disabled");
        }
        const lease = await host.beginTurn(
          body.traceId,
          preferences.showBrowserDuringTurns === true,
          body.helperPid,
          body.conversationKey,
          body.connectorIdentity,
          body.requireRetainedConversation === true,
        );
        this.logger.info("browser.turn_started", { traceId: body.traceId });
        this.reportTurnEvent({ type: "start", traceId: body.traceId, conversationKey: body.conversationKey, manual: false });
        writeJson(response, 200, { ok: true, ...lease });
        return;
      } else if (request.url === "/v1/turn/heartbeat") {
        host.heartbeatTurn(body.traceId, body.helperPid, body.refreshViewport === true);
        this.reportTurnEvent({ type: "heartbeat", traceId: body.traceId });
        this.logger.debug?.("browser.turn_heartbeat", { traceId: body.traceId });
        writeJson(response, 200, { ok: true });
        return;
      } else {
        if (!['completed', 'failed', 'aborted'].includes(body.status)) throw new Error("turn status is invalid");
        this.reportTurnEvent({
          type: "end", traceId: body.traceId, status: body.status, conversationKey: body.conversationKey,
          message: typeof body.message === "string" ? body.message : undefined, manual: false,
        });
        const release = await host.endTurn(
          body.traceId,
          body.helperPid,
          body.status,
          preferences.showBrowserDuringTurns === true,
          body.message,
          body.retain === true,
          body.connectorBound === true,
        );
        this.logger.info("browser.turn_ended", { traceId: body.traceId, status: body.status });
        writeJson(response, 200, { ok: true, ...release });
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("browser.control_rejected", { message });
      // A handler that already started its response can't be turned into a 4xx now.
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
        return;
      }
      const cancelled = error?.code === "turn_cancelled";
      const retainedUnavailable = error?.code === "retained_conversation_unavailable";
      const manualInspectionDisabled = error?.code === "manual_browser_inspection_disabled";
      const manualOwnerLost = error?.code === "manual_turn_owner_lost";
      const manualTimedOut = error?.code === "manual_turn_timed_out";
      writeJson(
        response,
        cancelled || retainedUnavailable || manualInspectionDisabled || manualOwnerLost
          ? 409
          : manualTimedOut ? 408 : 400,
        {
        error: message,
        ...(cancelled ? { code: "turn_cancelled" } : {}),
        ...(retainedUnavailable ? { code: "retained_conversation_unavailable" } : {}),
        ...(manualInspectionDisabled ? { code: "manual_browser_inspection_disabled" } : {}),
        ...(manualOwnerLost ? { code: "manual_turn_owner_lost" } : {}),
        ...(manualTimedOut ? { code: "manual_turn_timed_out" } : {}),
        },
      );
    }
  }

  async forwardNativeFetch(request, response) {
    let url;
    try { url = new URL(request.headers["x-native-url"]); }
    catch { throw new Error("Native Codex URL is invalid"); }
    const paths = [
      "/backend-api/codex/models",
      "/backend-api/codex/responses",
      "/backend-api/codex/responses/compact",
      "/backend-api/codex/alpha/search",
      "/backend-api/codex/images/generations",
      "/backend-api/codex/images/edits",
    ];
    if (url.origin !== "https://chatgpt.com" || url.username || url.password || url.hash
      || !paths.includes(url.pathname)) throw new Error("Native fetch is restricted to Codex backend endpoints");
    const method = request.headers["x-native-method"];
    if (method !== (url.pathname.endsWith("/models") ? "GET" : "POST")) {
      throw new Error("Native Codex method is invalid");
    }
    const authorization = request.headers["x-native-authorization"];
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")
      || authorization.length <= 7) throw new Error("Native Codex authorization is invalid");
    if (!this.fetchNative) throw new Error("Native fetch relay is unavailable");

    const headers = new Headers();
    const excluded = new Set([
      "authorization", "cookie", "set-cookie", "host", "connection", "content-length",
      "transfer-encoding", "keep-alive", "te", "trailer", "upgrade",
      "proxy-authenticate", "proxy-authorization", "accept-encoding",
    ]);
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string" && !excluded.has(name)
        && !name.startsWith("x-native-") && !name.startsWith("sec-fetch-")) {
        headers.set(name, value);
      }
    }
    headers.set("authorization", authorization);

    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) throw new Error("Native Codex request body is too large");
      chunks.push(chunk);
    }
    if (method === "GET" && this.modelsCacheDir) {
      await this.forwardModels(url, headers, authorization, response);
      return;
    }
    const abort = new AbortController();
    response.on("close", () => { if (!response.writableEnded) abort.abort(); });
    let upstream;
    try {
      upstream = await this.fetchNative(url.href, {
        method, headers,
        ...(method === "POST" ? { body: Buffer.concat(chunks) } : {}),
        credentials: "omit", redirect: "manual", signal: abort.signal,
      });
    } catch (error) {
      if (response.destroyed) return;
      // Electron net errors carry no code, only "net::ERR_*" text; keep that name and nothing else.
      const netError = /^net::(ERR_[A-Z0-9_]+)$/.exec(String(error?.message ?? ""))?.[1] ?? null;
      this.logger.warn("browser.native_fetch_failed", {
        code: typeof error?.code === "string" ? error.code : "network_error",
        ...(netError ? { netError } : {}),
      });
      this.reportTurnEvent({ type: "native_fetch_failed", netError });
      writeJson(response, 502, {
        error: netError ? `Native Codex network request failed (${netError})` : "Native Codex network request failed",
        code: "native_network_error",
      });
      return;
    }
    this.reportTurnEvent({ type: "native_fetch_ok" });
    const outgoing = {};
    const excludedResponse = new Set([
      "content-length", "content-encoding", "set-cookie", "connection", "transfer-encoding",
      "keep-alive", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization",
    ]);
    for (const [name, value] of upstream.headers) {
      if (!excludedResponse.has(name)) outgoing[name] = value;
    }
    response.writeHead(upstream.status, outgoing);
    if (!upstream.body) {
      response.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(upstream.body), response);
    } catch (error) {
      // Headers are already on the wire, so no JSON error can follow; dropping the connection is
      // the only signal left. Never rethrow: handle() would try to write a second status line.
      if (!response.destroyed) response.destroy();
      // The caller hanging up mid-body (a cancelled turn, a catalog probe's own timeout) is routine.
      if (error?.code === "ERR_STREAM_PREMATURE_CLOSE" || error?.name === "AbortError") {
        this.logger.debug?.("browser.native_fetch_stream_closed", { path: url.pathname });
        return;
      }
      this.logger.warn("browser.native_fetch_stream_failed", {
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  modelsCacheFile(authorization, search) {
    const key = createHash("sha256").update(`${authorization}\n${search}`).digest("hex");
    return path.join(this.modelsCacheDir, `${key}.json`);
  }

  readModelsCache(file) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      return typeof saved?.body === "string" && typeof saved?.contentType === "string" ? saved : null;
    } catch { return null; }
  }

  writeModelsCache(file, contentType, body) {
    try {
      fs.mkdirSync(this.modelsCacheDir, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ contentType, body, savedAt: new Date().toISOString() }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      this.logger.warn("browser.native_models_cache_write_failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  // The live catalog request races a short timer; the cache answers whichever comes first
  // only when the live answer is late or not a success. Without a cache it behaves as before.
  async forwardModels(url, headers, authorization, response) {
    const file = this.modelsCacheFile(authorization, url.search);
    const cached = this.readModelsCache(file);
    const live = (async () => {
      const upstream = await this.fetchNative(url.href, { method: "GET", headers, credentials: "omit", redirect: "manual",
        signal: AbortSignal.timeout(60_000) });
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type") || "application/json";
      if (upstream.status === 200 && buffer.length <= MODELS_CACHE_MAX_BYTES) this.writeModelsCache(file, contentType, buffer.toString("utf8"));
      return { status: upstream.status, buffer, headers: [...upstream.headers] };
    })();
    live.catch(() => undefined);
    const serveCache = (reason) => {
      this.logger.info("browser.native_models_cache_served", { reason });
      response.writeHead(200, { "content-type": cached.contentType, "x-coding-tools-models-cache": reason });
      response.end(cached.body);
    };
    let timer;
    const late = cached ? new Promise((resolve) => { timer = setTimeout(() => resolve("late"), this.modelsCacheWaitMs); }) : new Promise(() => {});
    let outcome;
    try {
      outcome = await Promise.race([live, late]);
    } catch (error) {
      clearTimeout(timer);
      if (response.destroyed) return;
      if (cached) { serveCache("failed"); return; }
      const netError = /^net::(ERR_[A-Z0-9_]+)$/.exec(String(error?.message ?? ""))?.[1] ?? null;
      this.logger.warn("browser.native_fetch_failed", { code: typeof error?.code === "string" ? error.code : "network_error", ...(netError ? { netError } : {}) });
      this.reportTurnEvent({ type: "native_fetch_failed", netError });
      writeJson(response, 502, {
        error: netError ? `Native Codex network request failed (${netError})` : "Native Codex network request failed",
        code: "native_network_error",
      });
      return;
    }
    clearTimeout(timer);
    if (response.destroyed) return;
    if (outcome === "late") { serveCache("late"); return; }
    if (outcome.status !== 200 && cached) { serveCache(`http_${outcome.status}`); return; }
    this.reportTurnEvent({ type: "native_fetch_ok" });
    const dropped = new Set(["content-length", "content-encoding", "set-cookie", "connection", "transfer-encoding",
      "keep-alive", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization"]);
    response.writeHead(outcome.status, Object.fromEntries(outcome.headers.filter(([name]) => !dropped.has(name))));
    response.end(outcome.buffer);
  }

  async close() {
    if (!this.server.listening) return;
    await new Promise((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
    });
  }
}

module.exports = { BrowserControlServer, fetchNativeWithProxyAuth, MAX_MANUAL_START_BODY_BYTES, MANUAL_SENT_OBSERVER_TIMEOUT_MS };
