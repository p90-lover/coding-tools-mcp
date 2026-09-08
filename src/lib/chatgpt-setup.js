/** Public endpoint handling only. This module never stores tokens or calls ChatGPT APIs. */
export const CHATGPT_SETUP_URL = "https://chatgpt.com/plugins";

/** @param {string} value */
export function normalizeMcpEndpoint(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("A valid public HTTPS MCP endpoint is required."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
    throw new Error("Use a public HTTPS hostname without credentials, query parameters, or fragments.");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path || "/mcp";
  if (url.pathname !== "/mcp") throw new Error("Use the root /mcp endpoint; nested or duplicated /mcp paths are not supported.");
  return url.toString();
}

/**
 * Remembering an endpoint is not proof of a connected ChatGPT app.
 * @param {string} endpoint
 * @param {string} confirmedEndpoint
 */
export function connectionState(endpoint, confirmedEndpoint = "") {
  let current;
  try { current = normalizeMcpEndpoint(endpoint); } catch {
    return { status: "invalid_endpoint", endpoint: "", user_action_required: true, stable_hostname: false };
  }
  const stable_hostname = !new URL(current).hostname.endsWith(".trycloudflare.com");
  if (!confirmedEndpoint) return { status: "needs_setup", endpoint: current, user_action_required: true, stable_hostname };
  let confirmed;
  try { confirmed = normalizeMcpEndpoint(confirmedEndpoint); } catch { confirmed = ""; }
  return {
    status: current === confirmed ? "endpoint_unchanged" : "endpoint_changed",
    endpoint: current,
    user_action_required: current !== confirmed,
    stable_hostname,
  };
}

/** Canonicalize a configured tunnel origin or root MCP URL exactly once. @param {string} value */
export function endpointFromTunnel(value) {
  return normalizeMcpEndpoint(value);
}
