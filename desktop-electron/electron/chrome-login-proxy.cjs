const http = require("node:http");
const https = require("node:https");

// Chrome has no access to Electron's proxy-login callback. Keep the password here,
// and expose only a short-lived loopback endpoint to the dedicated login process.
async function createChromeLoginProxy({ endpoint, credentials, onAuthenticated = () => {} }) {
  if (!["http", "https"].includes(endpoint?.protocol)) {
    throw new Error("Chrome sign-in with saved credentials requires an HTTP or HTTPS proxy");
  }
  const transport = endpoint.protocol === "https" ? https : http;
  const authorization = "Basic " + Buffer.from(`${credentials.username || ""}:${credentials.password || ""}`).toString("base64");
  const sockets = new Set(), requests = new Set();
  const options = { hostname: endpoint.host.replace(/^\[|\]$/g, ""), port: endpoint.port, agent: false };
  let closing, reported = false;
  const trackSocket = socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(120_000, () => socket.destroy());
  };
  const trackRequest = request => {
    requests.add(request);
    request.once("close", () => requests.delete(request));
    request.once("socket", trackSocket);
    request.setTimeout(30_000, () => request.destroy(new Error("Configured proxy did not respond")));
    return request;
  };
  const server = http.createServer({ maxHeaderSize: 16 * 1024 }, (request, response) => {
    let target;
    try { target = new URL(request.url); } catch { response.writeHead(400).end(); return; }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      response.writeHead(400).end(); return;
    }
    const headers = { ...request.headers, host: target.host, "proxy-authorization": authorization };
    delete headers["proxy-connection"];
    const upstream = trackRequest(transport.request({ ...options, method: request.method, path: target.href, headers }, incoming => {
      const outgoing = { ...incoming.headers };
      delete outgoing["proxy-authenticate"];
      delete outgoing["proxy-authorization"];
      response.writeHead(incoming.statusCode === 407 ? 502 : incoming.statusCode, outgoing);
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
    }));
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("The configured proxy connection failed");
    });
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", trackSocket);
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, client, head) => {
    const target = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(request.url || "");
    if (!target || Number(target[2]) < 1 || Number(target[2]) > 65535) {
      client.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); return;
    }
    const upstream = trackRequest(transport.request({ ...options, method: "CONNECT", path: request.url,
      headers: { host: request.url, connection: "keep-alive", "proxy-connection": "keep-alive", "proxy-authorization": authorization } }));
    const fail = () => client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    upstream.on("error", fail);
    upstream.once("response", response => { response.resume(); fail(); });
    upstream.once("connect", (response, remote, remoteHead) => {
      upstream.setTimeout(0);
      remote.setTimeout(120_000, () => remote.destroy());
      if (response.statusCode !== 200 || client.destroyed || closing) { remote.destroy(); fail(); return; }
      if (!reported) { reported = true; try { onAuthenticated(); } catch {} }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (remoteHead.length) client.write(remoteHead);
      if (head.length) remote.write(head);
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
      client.pipe(remote); remote.pipe(client);
    });
    upstream.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return {
    proxyRules: `PROXY 127.0.0.1:${server.address().port}`,
    close() {
      closing ??= new Promise(resolve => {
        server.close(resolve);
        for (const request of requests) request.destroy();
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

module.exports = { createChromeLoginProxy };
