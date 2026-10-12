const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const { writePrivateFileAtomic } = require("./atomic-file.cjs");
const { DEFAULT_BYPASS, tcpErrorText } = require("./provider-network.cjs");

// The built-in gateway replaces ProxyBridge for the app's own traffic: a loopback HTTP proxy in
// Electron main that relays every request through one upstream proxy from the saved profiles.
// Node-side sockets reach ISP proxies that Chromium's in-process DNS could not.
const GATEWAY_HOST = "127.0.0.1";
const DEFAULT_GATEWAY_PORT = 17894;
// ProxyBridge owns 17891-17893; the gateway never listens there and never chains back to them.
const PROXYBRIDGE_PORTS = Object.freeze([17891, 17892, 17893]);
const GATEWAY_PROFILE_ID = "builtin-gateway";
const GATEWAY_PROFILE_NAME = "Built-in proxy gateway";
const GATEWAY_PROFILE_SCOPES = Object.freeze([
  "all", "browser", "provider", "oauth", "subagent", "mcp", "websocket", "http", "update",
]);
const UPSTREAM_PROTOCOLS = new Set(["http", "https", "socks5"]);
const DEFAULT_TRACE_URL = "https://chatgpt.com/cdn-cgi/trace";
const SETTINGS_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({
  connectTimeoutMs: 30_000,
  headerTimeoutMs: 30_000,
  idleTimeoutMs: 10 * 60_000,
  maxHeaderBytes: 64 * 1024,
  maxConnections: 1_024,
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
  400: "Bad Request",
  403: "Forbidden",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
});

class GatewayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function noop() {}

function bareHost(host) {
  return String(host || "").trim().replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHost(host) {
  const value = bareHost(host);
  return value === "localhost"
    || value.endsWith(".localhost")
    || value === "::1"
    || value === "0:0:0:0:0:0:0:1"
    || value === "0.0.0.0"
    || value === "::"
    || /^127\./.test(value)
    || /^::ffff:127\./.test(value);
}

function isLoopbackAddress(address) {
  const value = bareHost(address);
  return net.isIP(value) !== 0 && value !== "0.0.0.0" && value !== "::" && isLoopbackHost(value);
}

function validateGatewayPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("Gateway port must be between 1024 and 65535");
  }
  if (PROXYBRIDGE_PORTS.includes(port)) {
    throw new Error(`Port ${port} belongs to ProxyBridge; choose another gateway port`);
  }
  return port;
}

// Refuses an upstream that would send the gateway's traffic back into ProxyBridge or itself.
function validateUpstream(upstream, { gatewayPort = DEFAULT_GATEWAY_PORT } = {}) {
  if (!upstream || typeof upstream !== "object") throw new Error("Choose an upstream proxy profile first");
  const protocol = String(upstream.protocol || "").toLowerCase();
  if (!UPSTREAM_PROTOCOLS.has(protocol)) {
    throw new Error("The gateway upstream must be an HTTP, HTTPS or SOCKS5 proxy");
  }
  const host = bareHost(upstream.host);
  const port = Number(upstream.port);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The upstream proxy endpoint is invalid");
  }
  if (isLoopbackHost(host)
    && (PROXYBRIDGE_PORTS.includes(port) || port === DEFAULT_GATEWAY_PORT || port === gatewayPort)) {
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
  if (!host || !/^\d+$/.test(portText) || port < 1 || port > 65_535 || /[\s/@]/.test(host)) {
    throw new GatewayError(400, "Invalid tunnel target");
  }
  if (isLoopbackHost(host)) throw new GatewayError(403, "Loopback destinations are not routed by the gateway");
  return { host, port };
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

function ipv6Bytes(address) {
  let text = bareHost(address);
  const embedded = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (embedded) {
    const parts = embedded.slice(1).map(Number);
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
    const value = Number.parseInt(group || "0", 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new GatewayError(400, "Invalid IPv6 target");
    bytes.push((value >> 8) & 0xff, value & 0xff);
  }
  return bytes;
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

function connectUpstream(upstream, timeoutMs) {
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
    socket.once(secure ? "secureConnect" : "connect", () => finish());
    socket.once("error", (error) => finish(new GatewayError(502, `Upstream proxy unreachable: ${tcpErrorText(error)}`)));
  });
}

async function openHttpTunnel(upstream, host, port, limits) {
  const socket = await connectUpstream(upstream, limits.connectTimeoutMs);
  const reader = createSocketReader(socket);
  try {
    const authority = formatAuthority(host, port);
    socket.write(
      `CONNECT ${authority} HTTP/1.1\r\n`
      + `Host: ${authority}\r\n`
      + basicAuthorization(upstream)
      + "Proxy-Connection: Keep-Alive\r\n\r\n",
    );
    const status = statusOf(await reader.readHead(limits.maxHeaderBytes));
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

async function openSocks5Tunnel(upstream, host, port, limits) {
  const socket = await connectUpstream(upstream, limits.connectTimeoutMs);
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
    const addressLength = reply[3] === 0x01 ? 4 : reply[3] === 0x04 ? 16 : (await reader.readExact(1))[0];
    await reader.readExact(addressLength + 2);
    return { socket, rest: reader.release() };
  } catch (error) {
    reader.release();
    socket.destroy();
    throw error;
  }
}

function openTunnel(upstream, host, port, limits) {
  return upstream.protocol === "socks5"
    ? openSocks5Tunnel(upstream, host, port, limits)
    : openHttpTunnel(upstream, host, port, limits);
}

const HOP_BY_HOP = /^(proxy-authorization|proxy-connection|connection|keep-alive|proxy-authenticate|te|trailer|upgrade):/i;

// Plain proxy requests carry an absolute http:// URI; one request is relayed per connection.
function parseForwardRequest(head) {
  const lines = head.toString("latin1").split("\r\n").filter(Boolean);
  const match = /^([A-Z]+)\s+(\S+)\s+(HTTP\/1\.[01])$/i.exec(lines[0] || "");
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
  const headers = lines.slice(1).filter((line) => !HOP_BY_HOP.test(line));
  if (!headers.some((line) => /^host:/i.test(line))) headers.unshift(`Host: ${url.host}`);
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

function errorResponse(status, message) {
  const body = `${message}\n`;
  return `HTTP/1.1 ${status} ${STATUS_TEXT[status] || "Error"}\r\n`
    + "Content-Type: text/plain; charset=utf-8\r\n"
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + "Connection: close\r\n\r\n"
    + body;
}

function createProxyGateway({
  host = GATEWAY_HOST,
  port = DEFAULT_GATEWAY_PORT,
  getUpstream,
  logger = { info: noop, warn: noop },
  ...overrides
} = {}) {
  if (typeof getUpstream !== "function") throw new Error("Proxy gateway needs an upstream resolver");
  if (!isLoopbackAddress(host)) throw new Error("The proxy gateway only listens on loopback");
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const clients = new Set();
  const upstreams = new Set();
  const totals = {
    totalConnections: 0,
    rejectedConnections: 0,
    tunnels: 0,
    httpRequests: 0,
    failures: 0,
    bytesSent: 0,
    bytesReceived: 0,
  };
  let server = null;
  let listening = null;
  let startedAt = null;
  let lastError = null;
  let lastLoggedError = "";

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

  async function relayForward(client, reader, head) {
    const request = parseForwardRequest(head);
    const upstream = validateUpstream(getUpstream(), { gatewayPort: listening?.port });
    let socket;
    let rest = Buffer.alloc(0);
    let requestLine;
    if (upstream.protocol === "socks5") {
      ({ socket, rest } = await openSocks5Tunnel(upstream, request.host, request.port, limits));
      requestLine = `${request.method} ${request.url.pathname}${request.url.search} ${request.version}`;
    } else {
      socket = await connectUpstream(upstream, limits.connectTimeoutMs);
      requestLine = `${request.method} ${request.url.href} ${request.version}`;
    }
    track(socket, upstreams);
    const auth = upstream.protocol === "socks5" ? "" : basicAuthorization(upstream);
    socket.write(`${[requestLine, ...request.headers].join("\r\n")}\r\n${auth}\r\n`, "latin1");
    if (rest.length) client.write(rest);
    totals.httpRequests += 1;
    splice(client, reader.release(), socket);
  }

  async function handleClient(client) {
    client.on("error", noop);
    if (!isLoopbackAddress(client.remoteAddress)) {
      totals.rejectedConnections += 1;
      client.destroy();
      return;
    }
    if (clients.size >= limits.maxConnections) {
      totals.rejectedConnections += 1;
      client.end(errorResponse(503, "The gateway has too many open connections"));
      return;
    }
    totals.totalConnections += 1;
    track(client, clients);
    client.once("close", () => {
      totals.bytesReceived += client.bytesRead;
      totals.bytesSent += client.bytesWritten;
    });
    client.setNoDelay(true);
    client.setTimeout(limits.headerTimeoutMs, () => client.destroy());
    const reader = createSocketReader(client);
    let upstreamSocket = null;
    try {
      const head = await reader.readHead(limits.maxHeaderBytes);
      const requestLine = head.toString("latin1").split("\r\n", 1)[0];
      const connect = /^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i.exec(requestLine);
      if (!connect) {
        await relayForward(client, reader, head);
        return;
      }
      const target = parseAuthority(connect[1]);
      const upstream = validateUpstream(getUpstream(), { gatewayPort: listening?.port });
      const tunnel = await openTunnel(upstream, target.host, target.port, limits);
      upstreamSocket = tunnel.socket;
      track(upstreamSocket, upstreams);
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
      client.end(errorResponse(status, error instanceof Error ? error.message : "Gateway request failed"));
    }
  }

  function start() {
    if (server) return Promise.resolve(listening);
    return new Promise((resolve, reject) => {
      const candidate = net.createServer({ noDelay: true }, (client) => { void handleClient(client); });
      candidate.once("error", (error) => {
        const message = error?.code === "EADDRINUSE"
          ? `Port ${port} is already in use; choose another gateway port`
          : `Gateway could not listen: ${error?.message || error}`;
        lastError = { message, at: new Date().toISOString() };
        reject(new Error(message));
      });
      candidate.listen({ host, port, exclusive: true }, () => {
        candidate.removeAllListeners("error");
        candidate.on("error", (error) => recordError(error));
        server = candidate;
        const address = candidate.address();
        listening = { host, port: address.port };
        startedAt = new Date().toISOString();
        lastError = null;
        logger.info("proxy_gateway.listening", listening);
        resolve(listening);
      });
    });
  }

  function stop() {
    const active = server;
    server = null;
    listening = null;
    startedAt = null;
    for (const socket of [...clients, ...upstreams]) socket.destroy();
    if (!active) return Promise.resolve();
    return new Promise((resolve) => active.close(() => {
      logger.info("proxy_gateway.stopped", {});
      resolve();
    }));
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
    address: () => (listening ? { ...listening } : null),
    lastError: () => (lastError ? { ...lastError } : null),
    running: () => server !== null,
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
  if (end < 0) throw new Error("The trace response was incomplete");
  const head = raw.subarray(0, end).toString("latin1");
  const status = statusOf(raw.subarray(0, end + 4));
  let body = raw.subarray(end + 4);
  if (/\r\ntransfer-encoding:\s*chunked/i.test(head)) body = decodeChunked(body);
  return { status, body: body.toString("utf8") };
}

// Fetches a Cloudflare trace through the gateway, so the test exercises the same loopback hop and
// upstream chain the app's traffic takes.
async function fetchGatewayTrace({
  host = GATEWAY_HOST,
  port,
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
    const socket = await new Promise((resolve, reject) => {
      const candidate = net.connect({ host, port });
      sockets.push(candidate);
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", (error) => reject(new Error(`Gateway is not reachable: ${tcpErrorText(error)}`)));
    });
    socket.on("error", noop);
    const reader = createSocketReader(socket);
    let raw;
    if (target.protocol === "https:") {
      const targetPort = Number(target.port || 443);
      const authority = formatAuthority(bareHost(target.hostname), targetPort);
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
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
      socket.write(`GET ${target.href} HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: CodingTools-ProxyGateway\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`);
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

function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    enabled: false,
    port: DEFAULT_GATEWAY_PORT,
    upstreamProfileId: null,
    useForApp: false,
    previousGlobal: null,
  };
}

function normalizeSettings(value) {
  const fallback = defaultSettings();
  if (!value || typeof value !== "object" || value.version !== SETTINGS_VERSION) return fallback;
  let port = fallback.port;
  try {
    port = validateGatewayPort(value.port);
  } catch {}
  const previous = value.previousGlobal && typeof value.previousGlobal === "object"
    ? {
        enabled: value.previousGlobal.enabled === true,
        profileId: typeof value.previousGlobal.profileId === "string" ? value.previousGlobal.profileId : null,
      }
    : null;
  return {
    version: SETTINGS_VERSION,
    enabled: value.enabled === true,
    port,
    upstreamProfileId: typeof value.upstreamProfileId === "string" && value.upstreamProfileId
      ? value.upstreamProfileId
      : null,
    useForApp: value.useForApp === true,
    previousGlobal: previous,
  };
}

// Owns the gateway's settings and the "Use for this app" switch. Settings hold no secrets: the
// upstream credentials are read from the encrypted provider-network store when the gateway starts.
function createProxyGatewayController({
  userData,
  settingsPath = path.join(userData, "providers", "proxy-gateway.json"),
  network,
  logger = { info: noop, warn: noop },
  createGateway = createProxyGateway,
  fetchTrace = fetchGatewayTrace,
  traceUrl = DEFAULT_TRACE_URL,
  gatewayOptions = {},
}) {
  if (!network?.store || typeof network.applyGlobalRouting !== "function") {
    throw new Error("Proxy gateway needs the provider network controller");
  }
  const store = network.store;
  let settings;
  try {
    settings = normalizeSettings(JSON.parse(fs.readFileSync(settingsPath, "utf8")));
  } catch {
    settings = defaultSettings();
  }
  let upstream = null;
  let gateway = null;
  let lastError = null;
  let lastTest = null;

  function persist() {
    writePrivateFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  function fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = { message: message.slice(0, 500), at: new Date().toISOString() };
    return new Error(lastError.message);
  }

  function routeUsesGateway(routing = store.snapshot().routing) {
    return routing.globalEnabled === true && routing.globalProfileId === GATEWAY_PROFILE_ID;
  }

  function resolveUpstream(profileId = settings.upstreamProfileId) {
    if (!profileId) throw new Error("Choose an upstream proxy profile first");
    if (profileId === GATEWAY_PROFILE_ID) {
      throw new Error("The gateway cannot use its own profile as the upstream");
    }
    const profile = store.activeProxy(profileId);
    if (!profile) throw new Error("The upstream proxy profile was not found or is disabled");
    const credentials = profile.hasAuthentication ? store.proxySecret(profile.id) : null;
    if (profile.hasAuthentication && !credentials?.username && !credentials?.password) {
      throw new Error("Saved upstream proxy credentials are unavailable");
    }
    return validateUpstream({
      protocol: profile.endpoint.protocol,
      host: profile.endpoint.host,
      port: profile.endpoint.port,
      username: credentials?.username || "",
      password: credentials?.password || "",
    }, { gatewayPort: settings.port });
  }

  function publicProfile(profile) {
    return profile
      ? {
          profileId: profile.id,
          name: profile.name,
          protocol: profile.endpoint.protocol,
          host: profile.endpoint.host,
          port: profile.endpoint.port,
          hasAuthentication: profile.hasAuthentication,
        }
      : null;
  }

  function status() {
    const snapshot = store.snapshot();
    const findProfile = (id) => snapshot.proxyProfiles.find((profile) => profile.id === id) ?? null;
    const globalProfile = snapshot.routing.globalProfileId ? findProfile(snapshot.routing.globalProfileId) : null;
    const running = gateway?.running() === true;
    const serverError = gateway?.lastError() ?? null;
    const errors = [lastError, serverError].filter(Boolean).sort((left, right) => right.at.localeCompare(left.at));
    return {
      enabled: settings.enabled,
      running,
      listen: gateway?.address() ?? { host: GATEWAY_HOST, port: settings.port },
      port: settings.port,
      reservedPorts: [...PROXYBRIDGE_PORTS],
      gatewayProfileId: GATEWAY_PROFILE_ID,
      upstreamProfileId: settings.upstreamProfileId,
      upstream: publicProfile(settings.upstreamProfileId ? findProfile(settings.upstreamProfileId) : null),
      useForApp: routeUsesGateway(snapshot.routing),
      globalRoute: {
        enabled: snapshot.routing.globalEnabled,
        profileId: snapshot.routing.globalProfileId,
        profile: publicProfile(globalProfile),
      },
      previousGlobal: settings.previousGlobal ? { ...settings.previousGlobal } : null,
      stats: gateway?.stats() ?? null,
      lastError: errors[0] ?? null,
      lastTest: lastTest ? { ...lastTest } : null,
    };
  }

  async function startGateway() {
    upstream = resolveUpstream();
    if (gateway?.running()) return;
    const candidate = createGateway({
      host: GATEWAY_HOST,
      port: settings.port,
      getUpstream: () => upstream,
      logger,
      ...gatewayOptions,
    });
    await candidate.start();
    gateway = candidate;
    lastError = null;
    logger.info("proxy_gateway.started", {
      port: settings.port,
      upstreamProfileId: settings.upstreamProfileId,
      protocol: upstream.protocol,
      host: upstream.host,
      upstreamPort: upstream.port,
    });
  }

  async function stopGateway() {
    const active = gateway;
    gateway = null;
    upstream = null;
    if (active) await active.stop();
  }

  function ensureGatewayProfile() {
    const existing = store.snapshot().proxyProfiles.find((profile) => profile.id === GATEWAY_PROFILE_ID);
    if (existing?.archivedAt) {
      throw new Error("The built-in gateway profile was archived in Network Proxy and cannot be reused");
    }
    if (existing?.hasAuthentication) {
      throw new Error("The built-in gateway profile must not carry saved credentials");
    }
    const matches = existing
      && existing.enabled
      && existing.endpoint.protocol === "http"
      && existing.endpoint.host === GATEWAY_HOST
      && existing.endpoint.port === settings.port;
    if (matches) return;
    store.saveProxyProfile({
      id: GATEWAY_PROFILE_ID,
      name: GATEWAY_PROFILE_NAME,
      enabled: true,
      endpoint: { protocol: "http", host: GATEWAY_HOST, port: settings.port },
      scopes: [...GATEWAY_PROFILE_SCOPES],
      bypass: existing?.bypass ?? [...DEFAULT_BYPASS],
    });
  }

  // Puts back the global route that was active before "Use for this app" was switched on.
  function restorePreviousRoute() {
    if (!routeUsesGateway()) {
      settings.previousGlobal = null;
      return false;
    }
    const previous = settings.previousGlobal;
    const usable = previous?.profileId
      && previous.profileId !== GATEWAY_PROFILE_ID
      && store.activeProxy(previous.profileId);
    store.setGlobalRouting(usable && previous.enabled
      ? { enabled: true, profileId: previous.profileId }
      : { enabled: false, profileId: usable ? previous.profileId : null });
    settings.previousGlobal = null;
    return true;
  }

  // Called before the saved global route is applied at launch, so a route that points at the
  // gateway never starts against a closed port. A gateway that cannot start hands the app back
  // to the route it used before.
  async function startup() {
    const routed = routeUsesGateway();
    if (!settings.enabled && !routed) return status();
    try {
      await startGateway();
      if (routed) ensureGatewayProfile();
    } catch (error) {
      fail(error);
      logger.warn("proxy_gateway.startup_failed", { message: lastError.message });
      if (routed) {
        restorePreviousRoute();
        settings.useForApp = false;
        persist();
        logger.warn("proxy_gateway.route_restored", { profileId: store.snapshot().routing.globalProfileId });
      }
    }
    return status();
  }

  async function configure(input = {}) {
    if (!input || typeof input !== "object") throw new Error("Gateway settings are required");
    const next = { ...settings };
    if (Object.hasOwn(input, "port")) next.port = validateGatewayPort(input.port);
    if (Object.hasOwn(input, "upstreamProfileId")) {
      const profileId = typeof input.upstreamProfileId === "string" && input.upstreamProfileId.trim()
        ? input.upstreamProfileId.trim()
        : null;
      next.upstreamProfileId = profileId;
    }
    const previous = settings;
    settings = next;
    try {
      if (settings.upstreamProfileId) resolveUpstream();
      else if (gateway?.running()) throw new Error("Stop the gateway before clearing its upstream");
    } catch (error) {
      settings = previous;
      throw fail(error);
    }
    const portChanged = next.port !== previous.port;
    persist();
    if (gateway?.running()) {
      if (portChanged) {
        await stopGateway();
        try {
          await startGateway();
        } catch (error) {
          // Keep the app's route alive: go back to the port that was working.
          settings = previous;
          persist();
          await startGateway().catch(() => {});
          throw fail(error);
        }
      } else {
        upstream = resolveUpstream();
      }
    }
    if (portChanged && routeUsesGateway()) {
      ensureGatewayProfile();
      await network.applyGlobalRouting();
    }
    lastError = null;
    return status();
  }

  async function setRunning(running) {
    if (running === true) {
      try {
        await startGateway();
      } catch (error) {
        throw fail(error);
      }
      settings.enabled = true;
      persist();
      return status();
    }
    // Stopping the gateway also hands the app back to its previous route; leaving the global
    // route on a closed port would blank every proxied page.
    const restored = restorePreviousRoute();
    settings.enabled = false;
    settings.useForApp = false;
    persist();
    await stopGateway();
    if (restored) await network.applyGlobalRouting();
    return status();
  }

  async function setUseForApp(enabled) {
    if (enabled === true) {
      try {
        await startGateway();
        ensureGatewayProfile();
      } catch (error) {
        throw fail(error);
      }
      const routing = store.snapshot().routing;
      if (!routeUsesGateway(routing)) {
        settings.previousGlobal = { enabled: routing.globalEnabled, profileId: routing.globalProfileId };
      }
      store.setGlobalRouting({ enabled: true, profileId: GATEWAY_PROFILE_ID });
      settings.enabled = true;
      settings.useForApp = true;
      persist();
      await network.applyGlobalRouting();
      logger.info("proxy_gateway.app_route_enabled", { previousProfileId: settings.previousGlobal?.profileId ?? null });
      return status();
    }
    const restored = restorePreviousRoute();
    settings.useForApp = false;
    persist();
    if (restored) await network.applyGlobalRouting();
    logger.info("proxy_gateway.app_route_disabled", { profileId: store.snapshot().routing.globalProfileId });
    return status();
  }

  // Re-reads the upstream after its profile was edited or archived in Network Proxy.
  function refreshUpstream() {
    if (!gateway?.running()) return status();
    try {
      upstream = resolveUpstream();
      lastError = null;
    } catch (error) {
      upstream = null;
      fail(error);
    }
    return status();
  }

  async function test() {
    if (!gateway?.running()) throw fail(new Error("Start the gateway before testing it"));
    const at = new Date().toISOString();
    try {
      const result = await fetchTrace({ host: GATEWAY_HOST, port: gateway.address().port, url: traceUrl });
      lastTest = { ...result, at };
    } catch (error) {
      lastTest = { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500), at };
    }
    logger[lastTest.ok ? "info" : "warn"]("proxy_gateway.tested", {
      ok: lastTest.ok,
      loc: lastTest.loc,
      latencyMs: lastTest.latencyMs,
      error: lastTest.error,
    });
    return status();
  }

  // App quit: close the listener without changing the saved settings.
  function close() {
    const active = gateway;
    gateway = null;
    upstream = null;
    return active ? active.stop() : Promise.resolve();
  }

  return {
    status,
    startup,
    configure,
    setRunning,
    setUseForApp,
    refreshUpstream,
    test,
    close,
    upstreamProfileId: () => settings.upstreamProfileId,
  };
}

module.exports = {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_TRACE_URL,
  GATEWAY_PROFILE_ID,
  PROXYBRIDGE_PORTS,
  createProxyGateway,
  createProxyGatewayController,
  fetchGatewayTrace,
  isLoopbackAddress,
  isLoopbackHost,
  parseTrace,
  validateGatewayPort,
  validateUpstream,
};
