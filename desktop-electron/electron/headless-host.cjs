"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const CONTROL_SCHEMA = 1;
const CONTROL_PROTOCOL_VERSION = 1;
const START_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function regularFile(pathname, label) {
  const metadata = fs.lstatSync(pathname);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${label} must be a regular non-linked file`);
  }
  return metadata;
}

function within(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]").slice(0, 500);
}

function requestJson({ endpoint, token, localUiToken = null, pathname, method = "POST", body = null, timeout = REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
      reject(new Error("Refusing a non-loopback headless control endpoint"));
      return;
    }
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const request = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(localUiToken ? { "x-coding-tools-local-ui": localUiToken } : {}),
        accept: "application/json",
        ...(payload ? {
          "content-type": "application/json",
          "content-length": String(payload.length),
        } : {}),
      },
      timeout,
    });
    const chunks = [];
    let size = 0;
    request.on("response", (response) => {
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          request.destroy(new Error("Headless response exceeded the local size limit"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let value = {};
        try {
          value = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error("Headless service returned invalid JSON"));
          return;
        }
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          const message = value?.error?.message || "Headless service rejected the request";
          reject(new Error(safeErrorMessage(message)));
          return;
        }
        resolve(value);
      });
    });
    request.on("timeout", () => request.destroy(new Error("Headless request timed out")));
    request.on("error", (error) => reject(new Error(safeErrorMessage(error))));
    if (payload) request.write(payload);
    request.end();
  });
}

class HeadlessHost {
  constructor({ app, logger, sourceRoot }) {
    this.app = app;
    this.logger = logger;
    this.sourceRoot = sourceRoot;
    this.child = null;
    this.control = null;
    this.starting = null;
    this.stopping = false;
  }

  binaryPath() {
    const suffix = process.platform === "win32" ? ".exe" : "";
    const name = `coding-tools-headless${suffix}`;
    const candidates = [
      process.env.CODING_TOOLS_HEADLESS_BINARY,
      this.app.isPackaged ? path.join(process.resourcesPath, "coding-tools", name) : null,
      path.join(this.sourceRoot, "rust-core", "target", "debug", name),
      path.join(this.sourceRoot, "rust-core", "target", "release", name),
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        regularFile(candidate, "Headless executable");
        return path.resolve(candidate);
      } catch {
        // Continue through deterministic local candidates.
      }
    }
    throw new Error("Packaged Paseo/Anneal headless executable is unavailable");
  }

  async ensureStarted() {
    if (this.control && this.child && this.child.exitCode === null) return this.control;
    if (this.starting) return this.starting;
    this.starting = this.start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async start() {
    if (this.stopping) throw new Error("Local execution service is stopping");
    const executable = this.binaryPath();
    const appDataDir = path.join(this.app.getPath("userData"), "headless");
    const id = `${process.pid}-${crypto.randomUUID()}`;
    const uiToken = crypto.randomBytes(32).toString("base64url");
    const descriptorPath = path.join(appDataDir, "runtime", `control-${id}.json`);
    const tokenPath = path.join(appDataDir, "aiTemp", "headless-control", `token-${id}.txt`);
    fs.mkdirSync(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });

    const child = spawn(executable, ["serve"], {
      cwd: path.dirname(executable),
      env: {
        ...process.env,
        CODING_TOOLS_APP_DATA_DIR: appDataDir,
        CODING_TOOLS_CONTROL_DESCRIPTOR_FILE: descriptorPath,
        CODING_TOOLS_CONTROL_TOKEN_FILE: tokenPath,
        CODING_TOOLS_LOCAL_UI_STDIN: "1",
      },
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    this.child = child;
    if (!child.stdin) {
      child.kill();
      throw new Error("Headless local UI channel unavailable");
    }
    child.stdin.on("error", (error) => {
      this.logger.warn("headless.local_ui_channel_failed", { message: safeErrorMessage(error) });
    });
    child.stdin.end(uiToken + "\n");
    child.once("exit", (code, signal) => {
      const expected = this.stopping;
      this.control = null;
      if (this.child === child) this.child = null;
      if (!expected) {
        this.logger.warn("headless.unexpected_exit", {
          code: Number.isInteger(code) ? code : null,
          signal: signal || null,
        });
      }
    });
    child.once("error", (error) => {
      this.logger.error("headless.spawn_failed", { message: safeErrorMessage(error) });
    });

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Local execution service exited during startup (${child.exitCode})`);
      }
      if (fs.existsSync(descriptorPath) && fs.existsSync(tokenPath)) {
        try {
          const descriptor = this.readDescriptor(descriptorPath, appDataDir, child.pid);
          const token = this.readToken(descriptor, tokenPath, appDataDir);
          const health = await requestJson({
            endpoint: descriptor.endpoint,
            token,
            pathname: "/control/v1/health",
            method: "GET",
            timeout: 2_000,
          });
          if (health.ready !== true || health.protocol_version !== CONTROL_PROTOCOL_VERSION) {
            throw new Error("Headless health contract is not ready");
          }
          this.control = Object.freeze({
            endpoint: descriptor.endpoint,
            token,
            uiToken,
            descriptorPath,
            tokenPath,
          });
          this.logger.info("headless.ready", {
            pid: child.pid,
            protocolVersion: descriptor.protocol_version,
            version: descriptor.version,
          });
          return this.control;
        } catch (error) {
          if (Date.now() + 100 >= deadline) throw error;
        }
      }
      await sleep(100);
    }
    child.kill();
    throw new Error("Local execution service did not become ready");
  }

  readDescriptor(descriptorPath, appDataDir, pid) {
    const metadata = regularFile(descriptorPath, "Headless descriptor");
    if (metadata.size > 64 * 1024) throw new Error("Headless descriptor is too large");
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (descriptor.schema !== CONTROL_SCHEMA
      || descriptor.protocol_version !== CONTROL_PROTOCOL_VERSION
      || descriptor.status !== "ready"
      || descriptor.pid !== pid
      || descriptor.app_data_dir !== appDataDir) {
      throw new Error("Headless descriptor identity check failed");
    }
    const endpoint = new URL(descriptor.endpoint);
    if (endpoint.protocol !== "http:"
      || endpoint.hostname !== "127.0.0.1"
      || endpoint.username
      || endpoint.password
      || endpoint.pathname !== "/") {
      throw new Error("Headless descriptor endpoint is not a private loopback listener");
    }
    if (!Number.isInteger(Number(endpoint.port)) || Number(endpoint.port) < 1 || Number(endpoint.port) > 65535) {
      throw new Error("Headless descriptor port is invalid");
    }
    return descriptor;
  }

  readToken(descriptor, expectedTokenPath, appDataDir) {
    const tokenFile = path.resolve(descriptor.token_file);
    if (tokenFile !== path.resolve(expectedTokenPath) || !within(appDataDir, tokenFile)) {
      throw new Error("Headless token file escaped the private application directory");
    }
    const metadata = regularFile(tokenFile, "Headless token");
    if (metadata.size < 32 || metadata.size > 1024) throw new Error("Headless token length is invalid");
    const token = fs.readFileSync(tokenFile, "utf8").trim();
    const digest = crypto.createHash("sha256").update(token, "utf8").digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(descriptor.token_sha256))) {
      throw new Error("Headless token digest check failed");
    }
    return token;
  }

  async request(pathname, body = null, options = {}) {
    const control = await this.ensureStarted();
    const method = options.method || (body == null ? "GET" : "POST");
    try {
      return await requestJson({
        endpoint: control.endpoint,
        token: control.token,
        localUiToken: options.localConfirmation === true ? control.uiToken : null,
        pathname,
        method,
        body,
        timeout: options.timeout ?? REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(safeErrorMessage(error));
    }
  }

  async shutdown(reason = "launcher-quit") {
    this.stopping = true;
    const child = this.child;
    const control = this.control;
    if (!child) return { ok: true, stopped: false };
    if (control && child.exitCode === null) {
      try {
        await requestJson({
          endpoint: control.endpoint,
          token: control.token,
          pathname: "/control/v1/shutdown",
          body: { reason },
          timeout: 5_000,
        });
      } catch (error) {
        this.logger.warn("headless.shutdown_request_failed", {
          message: safeErrorMessage(error),
        });
      }
    }
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      sleep(5_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null) child.kill();
    this.control = null;
    this.child = null;
    return { ok: true, stopped: true };
  }
}

module.exports = Object.freeze({
  HeadlessHost,
  requestJson,
});
