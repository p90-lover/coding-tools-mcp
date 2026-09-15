import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const ROUTED_AGENT_PREFIX = "coding-tools-router-";
const MANAGED_AGENT_FILE = /^coding-tools-router-[a-z0-9-]+-[a-f0-9]{10}\.toml$/;
const ROUTED_MODEL = /^[^\s\u0000-\u001f\u007f]{1,240}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface RoutedAgentDefinition {
  model: string;
  agentName: string;
  fileName: string;
  contents: string;
}

export interface RoutedAgentSyncOptions {
  agentsDir: string;
  trashDir?: string;
}

export interface RoutedAgentSyncResult {
  written: Array<{ model: string; path: string }>;
  unchanged: Array<{ model: string; path: string }>;
  preserved: Array<{ from: string; to: string; reason: "replaced" | "stale" }>;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function normalizedIdentifier(value: string, separator: "-" | "_"): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`^\\${separator}+|\\${separator}+$`, "g"), "");
  return normalized || "model";
}

function slugHash(slug: string): string {
  return createHash("sha256").update(slug, "utf8").digest("hex").slice(0, 10);
}

function requireRoutedModel(slug: string): string {
  const normalized = slug.trim();
  if (!ROUTED_MODEL.test(normalized) || !normalized.includes("/")) {
    throw new Error(`Invalid routed model slug: ${normalized || "<empty>"}`);
  }
  if (normalized.startsWith("codex-router/")) {
    throw new Error("Routed agent definitions require the router slug without the Coding Tools namespace");
  }
  return normalized;
}

export function routedAgentDefinition(slug: string): RoutedAgentDefinition {
  const model = requireRoutedModel(slug);
  const hash = slugHash(model);
  const fileStem = `${ROUTED_AGENT_PREFIX}${normalizedIdentifier(model, "-")}-${hash}`;
  const agentName = `coding_tools_router_${normalizedIdentifier(model, "_")}_${hash}`;
  const contents = [
    "# Managed by Coding Tools. This file contains no provider credential.",
    `name = ${tomlString(agentName)}`,
    `description = ${tomlString(`${model} subagent routed through the authenticated local Codex Router.`)}`,
    'model_provider = "codex-router"',
    `model = ${tomlString(model)}`,
    "",
    'developer_instructions = """',
    "Complete only the bounded task assigned by the parent agent.",
    "Respect repository instructions and preserve user data.",
    "Run only verification relevant to the assigned task and report concrete evidence.",
    "Do not invent provider, model, tool, or agent names that were not offered by the current harness.",
    '"""',
    "",
  ].join("\n");
  return { model, agentName, fileName: `${fileStem}.toml`, contents };
}

function normalizeRouterOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Codex Router provider URL must be a valid loopback origin");
  }
  if (
    !["http:", "https:"].includes(url.protocol)
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || url.search
    || url.hash
    || !["", "/"].includes(url.pathname)
  ) {
    throw new Error("Codex Router provider URL must be a credential-free loopback HTTP(S) origin");
  }
  return url.origin;
}

export function codexRouterProviderToml(origin: string): string {
  const normalized = normalizeRouterOrigin(origin);
  return [
    "# BEGIN coding-tools-codex-router-provider",
    "[model_providers.codex-router]",
    'name = "Codex Router (external models)"',
    `base_url = ${tomlString(`${normalized}/v1`)}`,
    'env_key = "CODING_TOOLS_CODEX_ROUTER_CALLER_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "# END coding-tools-codex-router-provider",
    "",
  ].join("\n");
}

function managedAgentFiles(agentsDir: string): string[] {
  try {
    return readdirSync(agentsDir)
      .filter(entry => MANAGED_AGENT_FILE.test(entry))
      .sort();
  } catch {
    return [];
  }
}

function uniquePreservedDestination(trashSession: string, fileName: string): string {
  const stem = basename(fileName);
  for (let index = 0; index < 10_000; index += 1) {
    const suffix = index === 0 ? "" : `-${index}`;
    const candidate = join(trashSession, `${stem}${suffix}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate retained destination for ${fileName}`);
}

function preserveManagedFile(
  source: string,
  trashSession: string,
  reason: "replaced" | "stale",
): { from: string; to: string; reason: "replaced" | "stale" } {
  mkdirSync(trashSession, { recursive: true, mode: 0o700 });
  const destination = uniquePreservedDestination(trashSession, basename(source));
  renameSync(source, destination);
  return { from: source, to: destination, reason };
}

function writePrivateNewFile(path: string, contents: string): void {
  writeFileSync(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ACL ownership is handled by the containing Codex profile.
  }
}

export function syncRoutedAgentDefinitions(
  slugs: string[],
  { agentsDir, trashDir = join(dirname(agentsDir), "Trash", "coding-tools-routed-agents") }: RoutedAgentSyncOptions,
): RoutedAgentSyncResult {
  mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
  const definitions = [...new Map(
    slugs.map(slug => {
      const definition = routedAgentDefinition(slug);
      return [definition.fileName, definition] as const;
    }),
  ).values()].sort((left, right) => left.fileName.localeCompare(right.fileName));
  const desiredFiles = new Set(definitions.map(definition => definition.fileName));
  const result: RoutedAgentSyncResult = { written: [], unchanged: [], preserved: [] };
  const trashSession = join(trashDir, `${Date.now()}-${process.pid}`);

  for (const definition of definitions) {
    const target = join(agentsDir, definition.fileName);
    if (existsSync(target)) {
      const current = readFileSync(target, "utf8");
      if (current === definition.contents) {
        result.unchanged.push({ model: definition.model, path: target });
        continue;
      }
      result.preserved.push(preserveManagedFile(target, trashSession, "replaced"));
    }
    writePrivateNewFile(target, definition.contents);
    result.written.push({ model: definition.model, path: target });
  }

  for (const fileName of managedAgentFiles(agentsDir)) {
    if (desiredFiles.has(fileName)) continue;
    result.preserved.push(
      preserveManagedFile(join(agentsDir, fileName), trashSession, "stale"),
    );
  }
  return result;
}
