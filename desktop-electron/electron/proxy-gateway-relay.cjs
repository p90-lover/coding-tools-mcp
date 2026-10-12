"use strict";

// Built-in proxy gateway: the relay and its standalone helper entry.
//
// The gateway runs as a detached helper process (bundled Bun in a package, Electron as Node in
// development) so it outlives app restarts and installs like the Codex bridge and CPA, which keep
// their proxy route in their environment. The next app instance adopts it over the control port.
//
// Listeners, all on 127.0.0.1 only:
// - data port (default 17894): an HTTP proxy (CONNECT tunnels and absolute-URI http:// requests)
//   that requires `Proxy-Authorization: Basic` with a per-helper random token as the password.
//   Loopback is reachable by every local user's processes, so this keeps them off the paid upstream.
// - token-free port (default 17895): the same relay WITHOUT authentication. It exists only for
//   ChatGPT Desktop, which receives its route as `--proxy-server` and cannot carry credentials.
//   It is closed by default; the app opens it over the control port only while a ChatGPT Desktop
//   instance runs, renewing a lease with a heartbeat. The helper closes it by itself when the
//   lease lapses (about 30 s after the app quits or crashes); a ChatGPT Desktop instance still
//   running then loses its proxy. While open, any local process can use it (ProxyBridge's 17891
//   exposure).
// - control port (ephemeral): status, stop and token-free open/close for the app, guarded by a
//   random bearer token. The same token lets the app probe which process holds the data port.
//
// Every request is relayed through one upstream proxy: http/https (CONNECT chaining with Basic
// proxy auth) or SOCKS5 (RFC 1928/1929 username/password). The upstream credentials arrive on
// stdin as one JSON line and live only in this process's memory; they are never logged.
//
// This file may require Node built-ins only: a package runs it from app.asar.unpacked with Bun.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const tls = require("node:tls");
const { StringDecoder } = require("node:string_decoder");

const GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 17894;
const DEFAULT_TOKENLESS_PORT = 17895;
// ProxyBridge owns 17891-17893; the gateway never listens there and never chains back to them.
const PROXYBRIDGE_PORTS = Object.freeze([17891, 17892, 17893]);
const HELPER_SERVICE = "coding-tools-proxy-gateway";
const PROBE_PATH = "/.well-known/coding-tools-gateway";
const PROBE_HEADER = "x-coding-tools-probe";
const DEFAULT_TOKENLESS_LEASE_MS = 30_000;
const PROXY_USERNAME = "ct";
const UPSTREAM_PROTOCOLS = new Set(["http", "https", "socks5"]);
const DEFAULT_TRACE_URL = "https://chatgpt.com/cdn-cgi/trace";
const DEFAULT_LIMITS = Object.freeze({
  connectTimeoutMs: 30_000,
  headerTimeoutMs: 15_000,
  idleTimeoutMs: 10 * 60_000,
  maxHeaderBytes: 64 * 1024,
  maxConnections: 1_024,
  maxPendingConnections: 128,
});
const SOCKS5_REPLIES = Object.freeze({
  1: "general failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
});
const STATUS_TEXT = Object.freeze({
  200: "OK",
  400: "Bad Request",
  403: "Forbidden",
  407: "Proxy Authentication Required",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
});
const HOP_BY_HOP = new Set([
  "proxy-authorization", "proxy-connection", "connection", "keep-alive", "proxy-authenticate", "te", "trailer", "upgrade",
]);

class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function noop() {}

function connectErrorText(error) {
  if (!(error instanceof Error)) return String(error);
  const attempts = Array.isArray(error.errors)
    ? error.errors.map((item) => [item?.code, item?.address].filter(Boolean).join(" ")).filter(Boolean)
    : [];
  if (attempts.length) return `Connection failed: ${attempts.join(", ")}`;
  return error.message || error.code || "Connection failed";
}

function bareHost(host) {
  return String(host || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function ipv6Bytes(address) {
  let text = bareHost(address);
  const embedded = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (embedded) {
    const parts = embedded.slice(1).map(Number);
    if (parts.some((part) => part > 255)) throw new GatewayError(400, "Invalid IPv6 target");
    text = `${text.slice(0, -embedded[0].length)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) throw new GatewayError(400, "Invalid IPv6 target");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
  if (groups.length !== 8) throw new GatewayError(400, "Invalid IPv6 target");
  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) throw new GatewayError(400, "Invalid IPv6 target");
    const value = Number.parseInt(group, 16);
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
}

// Canonical form of a host: brackets and trailing dots removed, and numeric IPv4 spellings
// (2130706433, 0177.0.0.1, 0x7f.1) resolved by the WHATWG URL parser.
function normalizeHost(host) {
  let value = bareHost(host).replace(/\.+$/, "");
  if (!value) return "";
  if (value.includes(":")) {
    try {
      return new URL(`http://[${value}]/`).hostname.slice(1, -1);
    } catch {
      return value;
    }
  }
  try {
    return new URL(`http://${value}/`).hostname.replace(/\.+$/, "");
  } catch {
    return value;
  }
}

function isLoopbackHost(host) {
  const value = normalizeHost(host);
  if (value === "localhost" || value.endsWith(".localhost")) return true;
  if (net.isIPv4(value)) return value.startsWith("127.") || value === "0.0.0.0";
  if (!net.isIPv6(value)) return false;
  let bytes;
  try {
    bytes = ipv6Bytes(value);
  } catch {
    return false;
  }
  const zeroUntil = (end) => bytes.slice(0, end).every((byte) => byte === 0);
  if (zeroUntil(15) && (bytes[15] === 1 || bytes[15] === 0)) return true;
  // IPv4-mapped (::ffff:127.x) and IPv4-compatible (::127.x) forms of 127/8 and 0.0.0.0.
  const mapped = zeroUntil(10) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = zeroUntil(12);
  const v4 = bytes.slice(12);
  return (mapped || compatible) && (v4[0] === 127 || v4.every((byte) => byte === 0));
}

function isLoopbackAddress(address) {
  const value = normalizeHost(address);
  return net.isIP(value) !== 0 && value !== "0.0.0.0" && value !== "::" && isLoopbackHost(value);
}

function validateGatewayPort(value, label = "Gateway port") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error(`${label} must be between 1024 and 65535`);
  }
  if (PROXYBRIDGE_PORTS.includes(port)) {
    throw new Error(`Port ${port} belongs to ProxyBridge; choose another gateway port`);
  }
  return port;
}

function loopPortsFor(ports = []) {
  return new Set([...PROXYBRIDGE_PORTS, DEFAULT_GATEWAY_PORT, DEFAULT_TOKENLESS_PORT, ...ports.filter(Number.isInteger)]);
}

// Refuses an upstream that would send the gateway's traffic back into ProxyBridge or itself.
function validateUpstream(upstream, { gatewayPorts = [] } = {}) {
  if (!upstream || typeof upstream !== "object") throw new Error("Choose an upstream proxy profile first");
  const protocol = String(upstream.protocol || "").toLowerCase();
  if (!UPSTREAM_PROTOCOLS.has(protocol)) {
    throw new Error("The gateway upstream must be an HTTP, HTTPS or SOCKS5 proxy");
  }
  const host = normalizeHost(upstream.host);
  const port = Number(upstream.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The upstream proxy endpoint is invalid");
  }
  if (isLoopbackHost(host) && loopPortsFor(gatewayPorts).has(port)) {
    throw new Error("That profile points back at ProxyBridge or the gateway itself; choose the real upstream proxy");
  }
  return {
    protocol,
    host,
    port,
    username: typeof upstream.username === "string" ? upstream.username : "",
    password: typeof upstream.password === "string" ? upstream.password : "",
  };
}

// Identifies an upstream without its password, so a state file can say which upstream a running
// helper uses.
function upstreamFingerprint(upstream) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([upstream.protocol, upstream.host, upstream.port, upstream.username || ""]))
    .digest("hex");
}

function formatAuthority(host, port) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

function parseAuthority(value) {
  const text = String(value || "");
  let host;
  let portText;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0 || text[end + 1] !== ":") throw new GatewayError(400, "Invalid tunnel target");
    host = text.slice(1, end);
    portText = text.slice(end + 2);
  } else {
    const separator = text.lastIndexOf(":");
    if (separator < 1) throw new GatewayError(400, "Tunnel target has no port");
    host = text.slice(0, separator);
    portText = text.slice(separator + 1);
  }
  const port = Number(portText);
  if (!host || !/^\d+$/.test(portText) || port < 1 || port > 65_535 || /[\s/@\\]/.test(host)) {
    throw new GatewayError(400, "Invalid tunnel target");
  }
  if (isLoopbackHost(host)) throw new GatewayError(403, "Loopback destinations are not routed by the gateway");
  return { host: bareHost(host), port };
}

function basicAuthorization(upstream) {
  if (!upstream.username && !upstream.password) return "";
  return `Proxy-Authorization: Basic ${Buffer.from(`${upstream.username}:${upstream.password}`, "utf8").toString("base64")}\r\n`;
}

function statusOf(head) {
  const line = head.toString("latin1").split("\r\n", 1)[0];
  const match = /^HTTP\/1\.[01]\s+(\d{3})\b/i.exec(line);
  if (!match) throw new GatewayError(502, "Upstream proxy returned an invalid HTTP status");
  return { line: line.slice(0, 160), code: Number(match[1]) };
}

// Splits a request head into its request line and headers. Bare LF, NUL, folded lines and odd
// header names are refused, so a header such as "Proxy-Authorization :" cannot slip past the
// hop-by-hop filter.
function parseHead(head) {
  const lines = head.toString("latin1").slice(0, -4).split("\r\n");
  if (lines.some((line) => /[\r\n\0]/.test(line))) throw new GatewayError(400, "Malformed request header");
  const [requestLine, ...rest] = lines;
  const headers = rest.map((line) => {
    if (/^[ \t]/.test(line)) throw new GatewayError(400, "Folded header lines are not accepted");
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new GatewayError(400, "Malformed request header");
    const value = line.slice(colon + 1).trim();
    return { name: name.toLowerCase(), line: `${name}: ${value}`, value };
  });
  return { requestLine, headers };
}

function proxyTokenMatches(headers, token) {
  const header = headers.find((entry) => entry.name === "proxy-authorization");
  const match = header ? /^basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.value) : null;
  if (!match) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 0) return false;
  const supplied = Buffer.from(decoded.slice(colon + 1), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function socks5Address(host, port) {
  const portBytes = [(port >> 8) & 0xff, port & 0xff];
  const version = net.isIP(host);
  if (version === 4) return Buffer.from([0x01, ...host.split(".").map(Number), ...portBytes]);
  if (version === 6) return Buffer.from([0x04, ...ipv6Bytes(host), ...portBytes]);
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new GatewayError(400, "SOCKS5 hostname is too long");
  return Buffer.concat([Buffer.from([0x03, name.length]), name, Buffer.from(portBytes)]);
}

// Buffers a socket during a handshake; release() pauses it and hands back any bytes read past the
// handshake so the following pipe() loses nothing.
function createSocketReader(socket) {
  let buffered = Buffer.alloc(0);
  let failure = null;
  let wake = null;
  const onData = (chunk) => {
    buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
    wake?.();
  };
  const onEnd = () => {
    failure ??= new GatewayError(502, "Connection closed during the proxy handshake");
    wake?.();
  };
  const onError = (error) => {
    failure ??= error;
    wake?.();
  };
  socket.on("data", onData);
  socket.on("end", onEnd);
  socket.on("close", onEnd);
  socket.on("error", onError);

  function waitFor(take) {
    return new Promise((resolve, reject) => {
      const check = () => {
        let result;
        try {
          result = take(buffered);
        } catch (error) {
          wake = null;
          reject(error);
          return;
        }
        if (result) {
          buffered = buffered.subarray(result.used);
          wake = null;
          resolve(result.value);
        } else if (failure) {
          wake = null;
          reject(failure);
        }
      };
      wake = check;
      check();
    });
  }

  return {
    readExact(size) {
      return waitFor((buffer) => (buffer.length >= size ? { value: buffer.subarray(0, size), used: size } : null));
    },
    readHead(limit) {
      return waitFor((buffer) => {
        const end = buffer.indexOf("\r\n\r\n");
        if (end >= 0 && end + 4 <= limit) return { value: buffer.subarray(0, end + 4), used: end + 4 };
        if (end >= 0 || buffer.length > limit) {
          throw new GatewayError(431, "HTTP header exceeds the gateway limit");
        }
        return null;
      });
    },
    readToEnd(limit) {
      return new Promise((resolve, reject) => {
        const check = () => {
          if (buffered.length > limit) {
            wake = null;
            reject(new Error("Response is too large"));
          } else if (failure) {
            wake = null;
            if (failure instanceof GatewayError) resolve(buffered);
            else reject(failure);
          }
        };
        wake = check;
        check();
      });
    },
    release() {
      socket.pause();
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
      const rest = buffered;
      buffered = Buffer.alloc(0);
      return rest;
    },
  };
}

function connectUpstream(upstream, { timeoutMs, loopPorts, onSocket = noop }) {
  return new Promise((resolve, reject) => {
    const secure = upstream.protocol === "https";
    const socket = secure
      ? tls.connect({
          host: upstream.host,
          port: upstream.port,
          servername: net.isIP(upstream.host) ? undefined : upstream.host,
          ALPNProtocols: ["http/1.1"],
        })
      : net.connect({ host: upstream.host, port: upstream.port });
    onSocket(socket);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(socket);
      }
    };
    socket.on("error", noop);
    // The timeout stays armed through the handshake that follows; splice() replaces it.
    socket.setTimeout(timeoutMs, () => {
      finish(new GatewayError(504, `Upstream proxy did not answer within ${Math.round(timeoutMs / 1000)} s`));
      socket.destroy(new GatewayError(504, "Upstream proxy handshake timed out"));
    });
    socket.once(secure ? "secureConnect" : "connect", () => {
      // A host name can still resolve back to this machine; refuse to chain into ourselves.
      if (loopPorts.has(socket.remotePort) && isLoopbackAddress(socket.remoteAddress)) {
        finish(new GatewayError(502, "The upstream resolves back to ProxyBridge or the gateway itself"));
        return;
      }
      finish();
    });
    socket.once("error", (error) => finish(new GatewayError(502, `Upstream proxy unreachable: ${connectErrorText(error)}`)));
  });
}

async function openHttpTunnel(upstream, host, port, options) {
  const socket = await connectUpstream(upstream, options);
  const reader = createSocketReader(socket);
  try {
    const authority = formatAuthority(host, port);
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\n`
      + `Host: ${authority}\r\n`
      + basicAuthorization(upstream)
      + "Proxy-Connection: Keep-Alive\r\n\r\n",
    );
    const status = statusOf(await reader.readHead(options.maxHeaderBytes));
    if (status.code === 407) throw new GatewayError(502, "Upstream proxy rejected the saved credentials (407)");
    if (status.code < 200 || status.code >= 300) {
      throw new GatewayError(502, `Upstream proxy refused the tunnel: ${status.line}`);
    }
    return { socket, rest: reader.release() };
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}

async function openSocks5Tunnel(upstream, host, port, options) {
  const socket = await connectUpstream(upstream, options);
  const reader = createSocketReader(socket);
  try {
    const withAuth = Boolean(upstream.username || upstream.password);
    socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    let reply = await reader.readExact(2);
    if (reply[0] !== 0x05) throw new GatewayError(502, "Upstream is not a SOCKS5 proxy");
    if (reply[1] === 0x02 && withAuth) {
      const user = Buffer.from(upstream.username, "utf8");
      const pass = Buffer.from(upstream.password, "utf8");
      if (user.length > 255 || pass.length > 255) throw new GatewayError(502, "SOCKS5 credentials are too long");
      socket.write(Buffer.concat([
        Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass,
      ]));
      reply = await reader.readExact(2);
      if (reply[1] !== 0x00) throw new GatewayError(502, "Upstream SOCKS5 proxy rejected the saved credentials");
    } else if (reply[1] !== 0x00) {
      throw new GatewayError(502, reply[1] === 0xff
        ? "Upstream SOCKS5 proxy accepted none of the offered authentication methods"
        : `Upstream SOCKS5 proxy selected unsupported method ${reply[1]}`);
    }
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socks5Address(host, port)]));
    reply = await reader.readExact(4);
    if (reply[0] !== 0x05 || reply[1] !== 0x00) {
      throw new GatewayError(502, `Upstream SOCKS5 connect failed: ${SOCKS5_REPLIES[reply[1]] || `code ${reply[1]}`}`);
    }
    let addressLength;
    if (reply[3] === 0x01) addressLength = 4;
    else if (reply[3] === 0x04) addressLength = 16;
    else if (reply[3] === 0x03) addressLength = (await reader.readExact(1))[0];
    else throw new GatewayError(502, `Upstream SOCKS5 reply has an unknown address type ${reply[3]}`);
    await reader.readExact(addressLength + 2);
    return { socket, rest: reader.release() };
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}

function openTunnel(upstream, host, port, options) {
  return upstream.protocol === "socks5"
    ? openSocks5Tunnel(upstream, host, port, options)
    : openHttpTunnel(upstream, host, port, options);
}

// Plain proxy requests carry an absolute http:// URI; one request is relayed per connection.
function parseForwardRequest(parsed) {
  const match = /^([A-Z]+)\s+(\S+)\s+(HTTP\/1\.[01])$/i.exec(parsed.requestLine || "");
  if (!match) throw new GatewayError(400, "Malformed proxy request");
  let url;
  try {
    url = new URL(match[2]);
  } catch {
    throw new GatewayError(400, "Proxy requests need an absolute http:// URL");
  }
  if (url.protocol !== "http:") {
    throw new GatewayError(400, "Only http:// URLs are forwarded; HTTPS uses CONNECT");
  }
  if (url.username || url.password) throw new GatewayError(400, "Proxy request URLs must not contain credentials");
  if (isLoopbackHost(url.hostname)) throw new GatewayError(403, "Loopback destinations are not routed by the gateway");
  const headers = parsed.headers.filter((entry) => !HOP_BY_HOP.has(entry.name)).map((entry) => entry.line);
  if (!parsed.headers.some((entry) => entry.name === "host")) headers.unshift(`Host: ${url.host}`);
  headers.push("Connection: close");
  return {
    method: match[1].toUpperCase(),
    version: match[3],
    url,
    host: bareHost(url.hostname),
    port: Number(url.port || 80),
    headers,
  };
}

function plainResponse(status, message, extraHeaders = "") {
  const body = `${message}\n`;
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status] || "Error"}\r\n`
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + extraHeaders
    + "Connection: close\r\n\r\n"
    + body;
}

function createProxyGateway({
  host = GATEWAY_HOST,
  port = DEFAULT_GATEWAY_PORT,
  tokenlessPort = null,
  // The token-free listener opens with start() unless this is false; the helper opens it only
  // while ChatGPT Desktop runs.
  openTokenlessAtStart = true,
  proxyToken,
  // Lets the app prove which process holds the data port without sending the access key.
  probeToken = null,
  getUpstream,
  logger = { info: noop, warn: noop },
  ...overrides
} = {}) {
  if (typeof getUpstream !== "function") throw new Error("Proxy gateway needs an upstream resolver");
  if (!isLoopbackAddress(host)) throw new Error("The proxy gateway only listens on loopback");
  if (typeof proxyToken !== "string" || proxyToken.length < 16) {
    throw new Error("The proxy gateway needs a proxy token");
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const clients = new Set();
  const pending = new Set();
  const upstreams = new Set();
  const totals = {
    totalConnections: 0,
    rejectedConnections: 0,
    authFailures: 0,
    tunnels: 0,
    httpRequests: 0,
    failures: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };
  let dataServer = null;
  let tokenlessServer = null;
  let tokenlessPromise = null;
  let listening = null;
  let startPromise = null;
  let startedAt = null;
  let lastError = null;
  let lastLoggedError = "";

  function loopPorts() {
    return loopPortsFor([listening?.port, listening?.tokenlessPort, port, tokenlessPort]);
  }

  function upstreamOptions() {
    return {
      timeoutMs: limits.connectTimeoutMs,
      maxHeaderBytes: limits.maxHeaderBytes,
      loopPorts: loopPorts(),
      onSocket: (socket) => track(socket, upstreams),
    };
  }

  function recordError(error) {
    const message = error instanceof Error ? error.message : String(error);
    totals.failures += 1;
    lastError = { message: message.slice(0, 500), at: new Date().toISOString() };
    if (message !== lastLoggedError) {
      lastLoggedError = message;
      logger.warn("proxy_gateway.request_failed", { message: lastError.message });
    }
  }

  function track(socket, set) {
    set.add(socket);
    socket.once("close", () => set.delete(socket));
  }

  function splice(client, clientRest, upstream) {
    client.removeAllListeners("timeout");
    upstream.removeAllListeners("timeout");
    const idle = () => {
      client.destroy();
      upstream.destroy();
    };
    client.setTimeout(limits.idleTimeoutMs > 0 ? limits.idleTimeoutMs : 0, idle);
    upstream.setTimeout(limits.idleTimeoutMs > 0 ? limits.idleTimeoutMs : 0, idle);
    if (clientRest.length) upstream.write(clientRest);
    client.pipe(upstream);
    upstream.pipe(client);
    // A closed client has nothing left to receive; a cleanly closed upstream lets the client
    // drain what was already piped before it ends.
    client.once("close", () => upstream.destroy());
    upstream.once("close", (hadError) => (hadError ? client.destroy() : client.end()));
  }

  function upstreamOrFail() {
    return validateUpstream(getUpstream(), { gatewayPorts: [...loopPorts()] });
  }

  async function relayForward(client, reader, parsed) {
    const request = parseForwardRequest(parsed);
    const upstream = upstreamOrFail();
    let socket;
    let rest = Buffer.alloc(0);
    let requestLine;
    if (upstream.protocol === "socks5") {
      ({ socket, rest } = await openSocks5Tunnel(upstream, request.host, request.port, upstreamOptions()));
      requestLine = `${request.method} ${request.url.pathname}${request.url.search} ${request.version}`;
    } else {
      socket = await connectUpstream(upstream, upstreamOptions());
      requestLine = `${request.method} ${request.url.href} ${request.version}`;
    }
    if (client.destroyed) {
      socket.destroy();
      return;
    }
    const auth = upstream.protocol === "socks5" ? "" : basicAuthorization(upstream);
    socket.write(`${[requestLine, ...request.headers].join("\r\n")}\r\n${auth}\r\n`, "latin1");
    if (rest.length) client.write(rest);
    totals.httpRequests += 1;
    splice(client, reader.release(), socket);
  }

  async function handleClient(client, { authenticated = true } = {}) {
    client.on("error", noop);
    if (!isLoopbackAddress(client.remoteAddress)) {
      totals.rejectedConnections += 1;
      client.destroy();
      return;
    }
    if (clients.size >= limits.maxConnections || pending.size >= limits.maxPendingConnections) {
      totals.rejectedConnections += 1;
      client.end(plainResponse(503, "The gateway has too many open connections"));
      return;
    }
    totals.totalConnections += 1;
    track(client, clients);
    track(client, pending);
    client.once("close", () => {
      totals.bytesReceived += client.bytesRead;
      totals.bytesSent += client.bytesWritten;
    });
    client.setNoDelay(true);
    // Fixed deadlines (not idle timers), so a client trickling bytes cannot hold a slot.
    let deadline = setTimeout(() => client.destroy(), limits.headerTimeoutMs);
    const reader = createSocketReader(client);
    let upstreamSocket = null;
    try {
      const head = await reader.readHead(limits.maxHeaderBytes);
      clearTimeout(deadline);
      deadline = setTimeout(() => client.destroy(), limits.connectTimeoutMs + limits.headerTimeoutMs);
      const parsed = parseHead(head);
      const allowed = !authenticated || proxyTokenMatches(parsed.headers, proxyToken);
      const probe = /^GET\s+\S+\s+HTTP\/1\.[01]$/i.test(parsed.requestLine)
        && parsed.requestLine.split(/\s+/)[1] === PROBE_PATH;
      if (probe && (allowed || tokensMatch(parsed.headers.find((entry) => entry.name === PROBE_HEADER)?.value, probeToken))) {
        reader.release();
        const body = JSON.stringify({ service: HELPER_SERVICE, pid: process.pid, listener: authenticated ? "data" : "tokenless" });
        client.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      if (!allowed) {
        totals.authFailures += 1;
        reader.release();
        client.end(plainResponse(407, "Proxy authentication required", 'Proxy-Authenticate: Basic realm="Coding Tools gateway"\r\n'));
        return;
      }
      const connect = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(parsed.requestLine);
      if (!connect) {
        await relayForward(client, reader, parsed);
        return;
      }
      const target = parseAuthority(connect[1]);
      const upstream = upstreamOrFail();
      const tunnel = await openTunnel(upstream, target.host, target.port, upstreamOptions());
      upstreamSocket = tunnel.socket;
      if (client.destroyed) {
        upstreamSocket.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (tunnel.rest.length) client.write(tunnel.rest);
      totals.tunnels += 1;
      splice(client, reader.release(), upstreamSocket);
    } catch (error) {
      upstreamSocket?.destroy();
      reader.release();
      if (client.destroyed) return;
      recordError(error);
      const status = error instanceof GatewayError ? error.status : 502;
      client.end(plainResponse(status, error instanceof Error ? error.message : "Gateway request failed"));
    } finally {
      clearTimeout(deadline);
      pending.delete(client);
    }
  }

  function listenOn(listenPort, authenticated) {
    return new Promise((resolve, reject) => {
      const candidate = net.createServer({ noDelay: true }, (client) => {
        void handleClient(client, { authenticated });
      });
      candidate.once("error", (error) => {
        reject(new Error(error?.code === "EADDRINUSE"
          ? `Port ${listenPort} is already in use; choose another gateway port`
          : `Gateway could not listen: ${error?.message || error}`));
      });
      candidate.listen({ host, port: listenPort, exclusive: true }, () => {
        candidate.removeAllListeners("error");
        candidate.on("error", (error) => recordError(error));
        resolve(candidate);
      });
    });
  }

  function closeServer(server) {
    return server ? new Promise((resolve) => server.close(() => resolve())) : Promise.resolve();
  }

  function refreshListening() {
    if (!listening) return;
    listening = { ...listening, tokenlessPort: tokenlessServer ? tokenlessServer.address().port : null };
  }

  // The unauthenticated listener exists only while something needs it (ChatGPT Desktop).
  function openTokenless() {
    if (tokenlessPort === null || tokenlessPort === undefined) {
      return Promise.reject(new Error("No token-free port is configured"));
    }
    if (tokenlessServer) return Promise.resolve(address());
    tokenlessPromise ??= listenOn(tokenlessPort, false).then((server) => {
      tokenlessServer = server;
      refreshListening();
      logger.info("proxy_gateway.tokenless_opened", { port: server.address().port });
      return address();
    }).finally(() => {
      tokenlessPromise = null;
    });
    return tokenlessPromise;
  }

  async function closeTokenless() {
    await tokenlessPromise?.catch(noop);
    const server = tokenlessServer;
    if (!server) return address();
    tokenlessServer = null;
    refreshListening();
    for (const client of clients) {
      if (client.localPort === server.address().port) client.destroy();
    }
    await closeServer(server);
    logger.info("proxy_gateway.tokenless_closed", {});
    return address();
  }

  function start() {
    if (listening) return Promise.resolve(listening);
    // Concurrent starts share one attempt instead of racing for the port.
    startPromise ??= (async () => {
      try {
        dataServer = await listenOn(port, true);
        listening = { host, port: dataServer.address().port, tokenlessPort: null };
        if (openTokenlessAtStart && tokenlessPort !== null && tokenlessPort !== undefined) await openTokenless();
        startedAt = new Date().toISOString();
        lastError = null;
        logger.info("proxy_gateway.listening", listening);
        return listening;
      } catch (error) {
        listening = null;
        await closeServer(dataServer);
        dataServer = null;
        lastError = { message: error.message, at: new Date().toISOString() };
        throw error;
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  }

  async function stop() {
    listening = null;
    startedAt = null;
    for (const socket of [...clients, ...upstreams]) socket.destroy();
    await tokenlessPromise?.catch(noop);
    const servers = [dataServer, tokenlessServer];
    dataServer = null;
    tokenlessServer = null;
    await Promise.all(servers.map(closeServer));
    logger.info("proxy_gateway.stopped", {});
  }

  function address() {
    return listening ? { ...listening } : null;
  }

  function stats() {
    let liveReceived = 0;
    let liveSent = 0;
    for (const client of clients) {
      liveReceived += client.bytesRead;
      liveSent += client.bytesWritten;
    }
    return {
      ...totals,
      activeConnections: clients.size,
      pendingConnections: pending.size,
      bytesReceived: totals.bytesReceived + liveReceived,
      bytesSent: totals.bytesSent + liveSent,
      startedAt,
    };
  }

  return {
    start,
    stop,
    stats,
    handleConnection: handleClient,
    openTokenless,
    closeTokenless,
    address,
    lastError: () => (lastError ? { ...lastError } : null),
    running: () => listening !== null,
  };
}

function decodeChunked(body) {
  const parts = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) break;
    const size = Number.parseInt(body.subarray(offset, lineEnd).toString("latin1"), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

function parseTrace(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function parseHttpResponse(raw) {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new Error("The response was incomplete");
  const head = raw.subarray(0, end).toString("latin1");
  const status = statusOf(raw.subarray(0, end + 4));
  let body = raw.subarray(end + 4);
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) body = decodeChunked(body);
  return { status, body: body.toString("utf8") };
}

function proxyAuthorizationLine(token) {
  return token
    ? `Proxy-Authorization: Basic ${Buffer.from(`${PROXY_USERNAME}:${token}`, "utf8").toString("base64")}\r\n`
    : "";
}

function openGatewaySocket(host, port, sockets) {
  return new Promise((resolve, reject) => {
    const candidate = net.connect({ host, port });
    sockets.push(candidate);
    candidate.once("connect", () => resolve(candidate));
    candidate.once("error", (error) => reject(new Error(`Gateway is not reachable: ${connectErrorText(error)}`)));
  });
}

// Asks a gateway listener which process holds it, so the app only routes to a port it knows is
// served by its own helper.
async function probeGateway({ host = GATEWAY_HOST, port, proxyToken = null, probeToken = null, timeoutMs = 2_000 } = {}) {
  const sockets = [];
  const timer = setTimeout(() => {
    for (const socket of sockets) socket.destroy(new Error("Gateway probe timed out"));
  }, timeoutMs);
  try {
    const socket = await openGatewaySocket(host, port, sockets);
    socket.on("error", noop);
    const reader = createSocketReader(socket);
    const probeLine = probeToken ? `X-Coding-Tools-Probe: ${probeToken}\r\n` : "";
    socket.write(`GET ${PROBE_PATH} HTTP/1.1\r\nHost: ${host}:${port}\r\n${proxyAuthorizationLine(proxyToken)}${probeLine}Connection: close\r\n\r\n`);
    const response = parseHttpResponse(await reader.readToEnd(16 * 1024));
    if (response.status.code !== 200) throw new Error(`Gateway probe answered ${response.status.line}`);
    const value = JSON.parse(response.body);
    if (value?.service !== HELPER_SERVICE || !Number.isInteger(value.pid)) throw new Error("Port is not served by the gateway");
    return value;
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
  }
}

// Fetches a Cloudflare trace through the gateway, so the test exercises the same loopback hop and
// upstream chain the app's traffic takes.
async function fetchGatewayTrace({
  host = GATEWAY_HOST,
  port,
  proxyToken = null,
  url = DEFAULT_TRACE_URL,
  timeoutMs = 15_000,
  tlsOptions = {},
} = {}) {
  const target = new URL(url);
  const started = Date.now();
  const sockets = [];
  const timer = setTimeout(() => {
    for (const socket of sockets) socket.destroy(new Error(`Trace timed out after ${Math.round(timeoutMs / 1000)} s`));
  }, timeoutMs);
  try {
    const socket = await openGatewaySocket(host, port, sockets);
    socket.on("error", noop);
    const reader = createSocketReader(socket);
    const auth = proxyAuthorizationLine(proxyToken);
    let raw;
    if (target.protocol === "https:") {
      const targetPort = Number(target.port || 443);
      const authority = formatAuthority(bareHost(target.hostname), targetPort);
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
      const head = await reader.readHead(DEFAULT_LIMITS.maxHeaderBytes);
      const status = statusOf(head);
      if (status.code !== 200) {
        const detail = (await reader.readToEnd(8_192).catch(() => Buffer.alloc(0))).toString("utf8").trim();
        throw new Error(detail || `Gateway answered ${status.line}`);
      }
      const rest = reader.release();
      if (rest.length) socket.unshift(rest);
      const secure = tls.connect({ socket, servername: bareHost(target.hostname), ALPNProtocols: ["http/1.1"], ...tlsOptions });
      sockets.push(secure);
      secure.on("error", noop);
      const secureReader = createSocketReader(secure);
      await new Promise((resolve, reject) => {
        secure.once("secureConnect", resolve);
        secure.once("error", reject);
        secure.once("close", () => reject(new Error("TLS closed during the handshake")));
      });
      secure.write(`GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: CodingTools-ProxyGateway\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`);
      raw = await secureReader.readToEnd(256 * 1024);
    } else {
      socket.write(`GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\n${auth}User-Agent: CodingTools-ProxyGateway\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`);
      raw = await reader.readToEnd(256 * 1024);
    }
    const response = parseHttpResponse(raw);
    if (response.status.code !== 200) {
      throw new Error(response.body.trim().slice(0, 300) || `Trace answered ${response.status.line}`);
    }
    const values = parseTrace(response.body);
    if (!values.ip) throw new Error("The trace response had no ip= line");
    return {
      ok: true,
      ip: values.ip,
      loc: values.loc || undefined,
      colo: values.colo || undefined,
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
  }
}

function tokensMatch(supplied, expected) {
  const left = Buffer.from(String(supplied || ""), "utf8");
  const right = Buffer.from(String(expected || ""), "utf8");
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function readConfigLine(stream, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    // A multibyte character (a non-ASCII password) can be split across chunks.
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onEnd);
    };
    const onData = (chunk) => {
      buffered += typeof chunk === "string" ? chunk : decoder.write(chunk);
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        cleanup();
        stream.pause?.();
        try {
          resolve(JSON.parse(buffered.slice(0, newline)));
        } catch {
          reject(new Error("Gateway configuration is not valid JSON"));
        }
      } else if (buffered.length > limit) {
        cleanup();
        reject(new Error("Gateway configuration is too large"));
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("Gateway configuration was not received"));
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onEnd);
  });
}

function relayScriptHash(file = __filename) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

// Lets the app check which access key a helper holds without the key leaving memory.
function accessKeyHash(key) {
  return crypto.createHash("sha256").update(`coding-tools-gateway-key:${key}`).digest("hex");
}

function requiredToken(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{32,128}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

// The standalone helper: reads its configuration (including the upstream credentials) as one JSON
// line from stdin, starts the listeners, reports one ready line on stdout and then only logs to
// stderr, which the app points at a file. It runs until the app asks it to stop.
async function runHelper({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, exit = (code) => process.exit(code) } = {}) {
  const log = (event, detail = {}) => {
    try {
      stderr.write(`${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail })}\n`);
    } catch {}
  };
  const report = (value) => {
    try {
      stdout.write(`${JSON.stringify(value)}\n`);
    } catch {}
  };
  stdout.on?.("error", noop);
  stderr.on?.("error", noop);
  let config;
  let gateway;
  let control;
  try {
    config = await readConfigLine(stdin);
    stdin.destroy?.();
    const dataPort = validateGatewayPort(config.dataPort, "Gateway port");
    const tokenlessPort = config.tokenlessPort === null ? null : validateGatewayPort(config.tokenlessPort, "Token-free port");
    const controlToken = requiredToken(config.controlToken, "Control token");
    const proxyToken = requiredToken(config.proxyToken, "Proxy token");
    const upstream = validateUpstream(config.upstream, { gatewayPorts: [dataPort, tokenlessPort] });
    const fingerprint = upstreamFingerprint(upstream);
    const upstreamProfileId = typeof config.upstreamProfileId === "string" ? config.upstreamProfileId : null;
    const appVersion = typeof config.appVersion === "string" ? config.appVersion.slice(0, 64) : null;
    // The app replaces a helper whose relay code or app version differs from its own.
    const scriptHash = relayScriptHash();
    const keyHash = accessKeyHash(proxyToken);
    const limits = config.limits && typeof config.limits === "object" ? config.limits : {};
    gateway = createProxyGateway({
      port: dataPort,
      tokenlessPort,
      openTokenlessAtStart: false,
      proxyToken,
      probeToken: controlToken,
      getUpstream: () => upstream,
      logger: { info: log, warn: log },
      ...Object.fromEntries(Object.entries(limits).filter(([key, value]) => key in DEFAULT_LIMITS && Number.isFinite(value))),
    });
    await gateway.start();
    const startedAt = new Date().toISOString();
    // The token-free port is leased: each open (the app's heartbeat) extends it, and the helper
    // closes the port by itself once the lease lapses, so an app that quits or crashes never
    // leaves it open.
    const leaseMs = Number.isFinite(config.tokenlessLeaseMs) && config.tokenlessLeaseMs >= 100
      ? config.tokenlessLeaseMs
      : DEFAULT_TOKENLESS_LEASE_MS;
    let leaseUntil = 0;
    const leaseTimer = setInterval(() => {
      if (leaseUntil && Date.now() > leaseUntil) {
        leaseUntil = 0;
        log("proxy_gateway.tokenless_lease_lapsed");
        void gateway.closeTokenless().catch(() => {});
      }
    }, Math.max(50, Math.min(1_000, Math.floor(leaseMs / 4))));
    control = http.createServer((request, response) => {
      const send = (status, value) => {
        const body = JSON.stringify(value);
        response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Connection: "close" });
        response.end(body);
      };
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        request.socket.destroy();
        return;
      }
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(request.headers.authorization || ""))?.[1];
      if (!tokensMatch(bearer, controlToken)) {
        send(401, { error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && request.url === "/status") {
        const address = gateway.address();
        send(200, {
          service: HELPER_SERVICE,
          version: 1,
          pid: process.pid,
          dataPort: address?.port ?? null,
          tokenlessPort: address?.tokenlessPort ?? null,
          tokenlessConfiguredPort: tokenlessPort,
          upstreamProfileId,
          fingerprint,
          keyHash,
          scriptHash,
          appVersion,
          startedAt,
          stats: gateway.stats(),
          lastError: gateway.lastError(),
        });
        return;
      }
      if (request.method === "POST" && (request.url === "/tokenless/open" || request.url === "/tokenless/close")) {
        const opening = request.url === "/tokenless/open";
        leaseUntil = opening ? Date.now() + leaseMs : 0;
        (opening ? gateway.openTokenless() : gateway.closeTokenless())
          .then((address) => send(200, { tokenlessPort: address?.tokenlessPort ?? null }))
          .catch((error) => send(409, { error: error instanceof Error ? error.message : String(error) }));
        return;
      }
      if (request.method === "POST" && request.url === "/stop") {
        send(200, { ok: true });
        log("proxy_gateway.stop_requested");
        setImmediate(async () => {
          clearInterval(leaseTimer);
          await gateway.stop().catch(() => {});
          control.close();
          setTimeout(() => exit(0), 50);
        });
        return;
      }
      send(404, { error: "not found" });
    });
    await new Promise((resolve, reject) => {
      control.once("error", reject);
      control.listen({ host: GATEWAY_HOST, port: 0 }, resolve);
    });
    const address = gateway.address();
    log("proxy_gateway.helper_ready", {
      dataPort: address.port,
      tokenlessPort: address.tokenlessPort,
      upstreamProfileId,
      protocol: upstream.protocol,
      host: upstream.host,
      upstreamPort: upstream.port,
    });
    report({ event: "ready", pid: process.pid, dataPort: address.port, tokenlessPort: address.tokenlessPort, controlPort: control.address().port });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("proxy_gateway.helper_failed", { message });
    report({ event: "failed", error: message });
    await gateway?.stop().catch(() => {});
    control?.close();
    exit(1);
  }
}

if (require.main === module) {
  process.on("uncaughtException", (error) => {
    try {
      process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event: "proxy_gateway.uncaught", message: error?.message || String(error) })}\n`);
    } catch {}
    process.exit(1);
  });
  void runHelper();
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_TOKENLESS_PORT,
  DEFAULT_TRACE_URL,
  GATEWAY_HOST,
  HELPER_SERVICE,
  PROXYBRIDGE_PORTS,
  PROXY_USERNAME,
  accessKeyHash,
  createProxyGateway,
  fetchGatewayTrace,
  isLoopbackAddress,
  isLoopbackHost,
  normalizeHost,
  parseTrace,
  probeGateway,
  readConfigLine,
  relayScriptHash,
  runHelper,
  upstreamFingerprint,
  validateGatewayPort,
  validateUpstream,
};
