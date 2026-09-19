"use strict";

const http = require("node:http");
const https = require("node:https");
const { errorMessage } = require("./sanitize.cjs");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function canonicalHostname(value) {
  const hostname = String(value || "").toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function assertLoopbackUrl(value, label = "Module endpoint") {
  const parsed = new URL(String(value || ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (!LOOPBACK_HOSTS.has(canonicalHostname(parsed.hostname))) {
    throw new Error(`${label} is restricted to 127.0.0.1 or [::1]`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  return parsed;
}

function joinUrl(origin, pathname = "/") {
  const base = assertLoopbackUrl(origin, "Module origin");
  const target = new URL(pathname, base);
  assertLoopbackUrl(target, "Module request URL");
  return target;
}

function requestJson(origin, {
  method = "GET",
  pathname = "/",
  body = null,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const target = joinUrl(origin, pathname);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
  if (payload && payload.length > MAX_BODY_BYTES) {
    throw new Error("Module request body is too large");
  }
  return new Promise((resolve, reject) => {
    const request = transport.request(target, {
      method,
      headers: {
        accept: "application/json,text/plain;q=0.8,*/*;q=0.1",
        ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          request.destroy(new Error("Module response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
        resolve({
          ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
          status: response.statusCode || 0,
          json,
          text: raw.slice(0, 4_000),
        });
      });
    });
    request.on("timeout", () => request.destroy(new Error("Module request timed out")));
    request.on("error", (error) => reject(new Error(errorMessage(error))));
    if (payload) request.write(payload);
    request.end();
  });
}

module.exports = {
  LOOPBACK_HOSTS,
  assertLoopbackUrl,
  joinUrl,
  requestJson,
};
