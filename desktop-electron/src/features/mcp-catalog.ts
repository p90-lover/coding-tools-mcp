import type { McpServerInput } from "../types";

/**
 * Plugins > MCPs made one click: well-known MCP servers ready to add (each with only the fields it
 * needs, a token at most), and any server's README snippet or `claude mcp add` line pasted in as
 * it is. Adding a server took a name, a command, arguments one per line and NAME=value lines typed
 * by hand from its README, and a Node server added as `npx` did not start on Windows at all.
 */

/** A value the person gives when adding a catalog server: a token, put in a header or an env var. */
export type McpCatalogSecret = {
  /** The header or env var it goes in. */
  key: string;
  in: "header" | "env";
  label: string;
  /** "Bearer {value}": how the header's value is written around what the person typed. */
  format?: string;
  optional?: boolean;
  /** Where to make one. */
  createUrl?: string;
  placeholder?: string;
};

export type McpCatalogEntry = {
  id: string;
  /** The server's name in chats (its tools read "<name>.<tool>"). */
  name: string;
  title: string;
  blurb: string;
  homepage: string;
  server: { type: "stdio"; command: string; args: string[] } | { type: "http"; url: string };
  secrets?: McpCatalogSecret[];
  /** The GitHub CLI's sign-in can stand in for the token (GitHub's own server only; see chat-mcp-servers.cjs). */
  githubCli?: boolean;
  /** The address of its read-only variant, offered as a switch. */
  readOnlyUrl?: string;
};

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    id: "github", name: "github", title: "GitHub", homepage: "https://github.com/github/github-mcp-server",
    blurb: "GitHub's official server: repositories, issues, pull requests, Actions and code search.",
    server: { type: "http", url: "https://api.githubcopilot.com/mcp/" }, readOnlyUrl: "https://api.githubcopilot.com/mcp/readonly",
    githubCli: true,
    secrets: [{ key: "Authorization", in: "header", format: "Bearer {value}", label: "GitHub token", placeholder: "github_pat_…",
      createUrl: "https://github.com/settings/personal-access-tokens/new" }],
  },
  {
    id: "playwright", name: "playwright", title: "Playwright", homepage: "https://github.com/microsoft/playwright-mcp",
    blurb: "Drives a real browser: open pages, click, type and read them through the accessibility tree.",
    server: { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
  },
  {
    id: "chrome-devtools", name: "chrome-devtools", title: "Chrome DevTools", homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    blurb: "Chrome's DevTools for agents: console, network, performance traces and screenshots.",
    server: { type: "stdio", command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
  },
  {
    id: "context7", name: "context7", title: "Context7", homepage: "https://github.com/upstash/context7",
    blurb: "Up-to-date docs and code examples for libraries, fetched for the version in use.",
    server: { type: "http", url: "https://mcp.context7.com/mcp" },
    secrets: [{ key: "CONTEXT7_API_KEY", in: "header", label: "API key (optional, for higher limits)", optional: true,
      createUrl: "https://context7.com/dashboard", placeholder: "ctx7sk-…" }],
  },
  {
    id: "sequential-thinking", name: "sequential-thinking", title: "Sequential Thinking", homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    blurb: "A scratchpad for step-by-step reasoning that the agent can revise and branch.",
    server: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
  },
];

/** Node launchers that are .cmd scripts on Windows: a process started without a shell can't find them. */
const NODE_LAUNCHERS = new Set(["npx", "npm", "pnpm", "pnpx", "yarn", "bunx"]);

/**
 * How a server is started on this computer. On Windows `npx` is `npx.cmd`, which an agent starting
 * the server without a shell cannot run, so it goes through `cmd /c` (as Claude Code's own docs say).
 */
export function launchFor(command: string, args: string[], windows: boolean): { command: string; args: string[] } {
  return windows && NODE_LAUNCHERS.has(command.toLowerCase()) ? { command: "cmd", args: ["/c", command, ...args] } : { command, args };
}

export const isWindows = () => typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** The server a catalog entry adds, with what the person typed in its fields. */
// `githubCli`: the token comes from the GitHub CLI in the main process, so its field is left out here.
export function catalogServer(entry: McpCatalogEntry, values: Record<string, string>, { windows = false, readOnly = false, githubCli = false } = {}): McpServerInput {
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  for (const secret of entry.secrets ?? []) {
    const value = (values[secret.key] ?? "").trim();
    if (!value) {
      if (secret.optional || (githubCli && entry.githubCli)) continue;
      throw new Error(`${secret.label} is required`);
    }
    (secret.in === "header" ? headers : env)[secret.key] = secret.format ? secret.format.replace("{value}", value) : value;
  }
  if (entry.server.type === "http") {
    return { name: entry.name, type: "http", enabled: true, url: readOnly && entry.readOnlyUrl ? entry.readOnlyUrl : entry.server.url, headers };
  }
  return { name: entry.name, type: "stdio", enabled: true, ...launchFor(entry.server.command, entry.server.args, windows), env };
}

/** What a paste turned into: the servers, and any `${…}` placeholders still to fill in. */
export type McpPasteResult = { servers: McpServerInput[]; placeholders: string[] };

const PLACEHOLDER = /\$\{[^}]+\}|<[A-Z][A-Z0-9_ -]*>|YOUR_[A-Z0-9_]+/g;

/** The README placeholders still in a field ("${input:token}", "YOUR_API_KEY", "<TOKEN>"), so a server is not saved with one. */
export const placeholdersIn = (text: string): string[] => [...new Set(text.match(PLACEHOLDER) ?? [])];
const NAME_SAFE = (raw: string) => raw.trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** One config object ({command,args,env} or {type,url,headers}) as a server. */
function serverOfConfig(name: string, config: Record<string, unknown>, windows: boolean): McpServerInput {
  const strings = (value: unknown, label: string): Record<string, string> => {
    if (value === undefined || value === null) return {};
    if (typeof value !== "object" || Array.isArray(value)) throw new Error(`"${name}": ${label} must be an object of names and values`);
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]));
  };
  const safe = NAME_SAFE(name);
  if (!safe) throw new Error("A server in the paste has no name");
  const type = String(config.type ?? config.transport ?? "").toLowerCase();
  if (typeof config.url === "string" || typeof config.serverUrl === "string" || type === "http" || type === "streamable-http" || type === "sse") {
    if (type === "sse") throw new Error(`"${safe}" uses SSE, an older transport chats here don't take. Look for its Streamable HTTP address (often ending in /mcp)`);
    const url = String(config.url ?? config.serverUrl ?? "");
    if (!url) throw new Error(`"${safe}" has no URL`);
    return { name: safe, type: "http", enabled: true, url, headers: strings(config.headers, "headers") };
  }
  if (typeof config.command !== "string" || !config.command.trim()) throw new Error(`"${safe}" has neither a command nor a URL`);
  const args = Array.isArray(config.args) ? config.args.map(String) : [];
  // A command written with its arguments in one string ("npx -y pkg") is split like a shell would.
  const [command, ...inline] = Array.isArray(config.args) ? [config.command.trim()] : shellWords(config.command);
  return { name: safe, type: "stdio", enabled: true, ...launchFor(command, [...inline, ...args], windows), env: strings(config.env, "env") };
}

/** Words as a shell splits them: spaces separate, quotes group, a backslash escapes outside single quotes. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = "", quote = "", started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === "\"" && /["\\$`]/.test(line[index + 1] ?? "")) word += line[++index];
      else word += char;
    } else if (char === "'" || char === "\"") { quote = char; started = true; }
    else if (char === "\\" && line[index + 1] === "\n") index += 1;
    else if (/\s/.test(char)) { if (started || word) words.push(word); word = ""; started = false; }
    else { word += char; started = true; }
  }
  if (quote) throw new Error("A quote in the command isn't closed");
  if (started || word) words.push(word);
  return words;
}

/** `claude mcp add …` or `codex mcp add …`, as either CLI reads it. */
function serverOfCommand(line: string, windows: boolean): McpServerInput {
  const words = shellWords(line.replace(/\\\r?\n/g, " "));
  const at = words.findIndex((word, index) => word === "add" && words[index - 1] === "mcp");
  if (at < 0) throw new Error("Paste a JSON config, or a `claude mcp add` / `codex mcp add` command");
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const positional: string[] = [];
  let transport = "", rest: string[] | null = null;
  for (let index = at + 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === "--") { rest = words.slice(index + 1); break; }
    const [flag, inlineValue] = word.startsWith("--") && word.includes("=") ? [word.slice(0, word.indexOf("=")), word.slice(word.indexOf("=") + 1)] : [word, undefined];
    const value = () => inlineValue ?? words[++index] ?? "";
    if (flag === "-e" || flag === "--env") {
      const pair = value();
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`${flag} needs NAME=value`);
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else if (flag === "-H" || flag === "--header") {
      const pair = value();
      const colon = pair.indexOf(":");
      if (colon <= 0) throw new Error(`${flag} needs "Name: value"`);
      headers[pair.slice(0, colon).trim()] = pair.slice(colon + 1).trim();
    } else if (flag === "-t" || flag === "--transport") transport = value().toLowerCase();
    else if (flag === "-s" || flag === "--scope") value();
    else if (flag === "--url") positional.push(value());
    else if (flag.startsWith("-")) continue;
    else positional.push(word);
  }
  const [name = "", target = ""] = positional;
  if (transport === "sse") throw new Error(`"${name}" uses SSE, an older transport chats here don't take`);
  if (!rest && (transport === "http" || /^https?:\/\//i.test(target))) {
    return serverOfConfig(name, { type: "http", url: target, headers }, windows);
  }
  const launch = rest ?? positional.slice(1);
  if (!launch.length) throw new Error(`"${name}" has no command after --`);
  return serverOfConfig(name, { command: launch[0], args: launch.slice(1), env }, windows);
}

/**
 * A pasted MCP config as servers: a README's JSON ({"mcpServers": …} for Claude, Cursor and
 * Windsurf, {"servers": …} for VS Code, {"mcp": {"servers": …}}, one {"name": {…}} or one bare
 * config), or a `claude mcp add` / `codex mcp add` line. Placeholders such as ${input:token} or
 * YOUR_API_KEY are kept and listed, so the form can ask for them.
 */
export function parseMcpPaste(text: string, { windows = false } = {}): McpPasteResult {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Paste a server's config or install command");
  let servers: McpServerInput[];
  if (/^[{[]/.test(trimmed)) {
    let parsed: unknown;
    // JSON with comments or trailing commas, as READMEs often show it, still reads.
    try { parsed = JSON.parse(trimmed); } catch {
      try { parsed = JSON.parse(trimmed.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1")); } catch { throw new Error("The paste isn't valid JSON"); }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The paste isn't an MCP config object");
    const root = parsed as Record<string, unknown>;
    const nested = (root.mcp as Record<string, unknown> | undefined)?.servers;
    const map = (root.mcpServers ?? root.servers ?? nested ?? root.context_servers) as Record<string, unknown> | undefined;
    const isConfig = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
      && ["command", "url", "serverUrl", "type"].some((key) => key in (value as object));
    if (map && typeof map === "object") {
      servers = Object.entries(map).filter(([, value]) => isConfig(value)).map(([name, value]) => serverOfConfig(name, value as Record<string, unknown>, windows));
    } else if (isConfig(root)) {
      servers = [serverOfConfig(String(root.name ?? "server"), root, windows)];
    } else {
      servers = Object.entries(root).filter(([, value]) => isConfig(value)).map(([name, value]) => serverOfConfig(name, value as Record<string, unknown>, windows));
    }
  } else {
    servers = [serverOfCommand(trimmed, windows)];
  }
  if (!servers.length) throw new Error("No MCP server found in the paste");
  const values = servers.flatMap((server) => [server.url ?? "", ...(server.args ?? []), ...Object.values(server.env ?? {}), ...Object.values(server.headers ?? {})]);
  const placeholders = placeholdersIn(values.join("\n"));
  return { servers, placeholders };
}
