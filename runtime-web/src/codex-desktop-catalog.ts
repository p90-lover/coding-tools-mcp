import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "./config";
import { atomicWriteFile, stripUtf8Bom } from "./config";
import {
  getCodexDesktopModelCatalogPath,
  getCodexHome,
  getCodexModelsCachePath,
} from "./codex-integration-shared";
import { readCodexModelContextOverride } from "./codex-integration-document";
import {
  augmentNativeModelCatalog,
  isMergedCodexDesktopCatalog,
  serializeCodexDesktopModelCatalog,
} from "./model-catalog";
import {
  augmentWithCodexRouterModels,
  resolveCodexRouterConnection,
} from "./routed-providers";

const NATIVE_MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.153.4";
const DESKTOP_USER_AGENT = "codex_chatgpt_desktop/0.153.4";

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function catalogFromUnknown(value: unknown): Record<string, unknown> | undefined {
  const root = object(value);
  if (root && Array.isArray(root.models)) return root;
  if (root && Array.isArray(root.data)) return { models: root.data };
  return undefined;
}

function readCodexAccessToken(): string | undefined {
  const authPath = join(getCodexHome(), "auth.json");
  if (!existsSync(authPath)) return undefined;
  try {
    const auth = object(JSON.parse(stripUtf8Bom(readFileSync(authPath, "utf8"))));
    const tokens = object(auth?.tokens);
    const token = tokens?.access_token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

export function readNativeCatalogFromModelsCache(): Record<string, unknown> | undefined {
  const cachePath = getCodexModelsCachePath();
  if (!existsSync(cachePath)) return undefined;
  try {
    return catalogFromUnknown(JSON.parse(stripUtf8Bom(readFileSync(cachePath, "utf8"))));
  } catch {
    return undefined;
  }
}

async function fetchJsonCatalog(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    return catalogFromUnknown(await response.json());
  } catch {
    return undefined;
  }
}

async function fetchNativeCodexModels(): Promise<Record<string, unknown> | undefined> {
  const token = readCodexAccessToken();
  if (!token) return undefined;
  return fetchJsonCatalog(NATIVE_MODELS_URL, {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "user-agent": DESKTOP_USER_AGENT,
  }, 25_000);
}

async function fetchLocalBridgeCatalog(config: AppConfig): Promise<Record<string, unknown> | undefined> {
  const token = readCodexAccessToken();
  if (!token) return undefined;
  return fetchJsonCatalog(
    `http://${config.host}:${config.port}/v1/models?client_version=0.153.4`,
    {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": DESKTOP_USER_AGENT,
    },
    25_000,
  );
}

export function persistCodexDesktopModelCatalog(catalog: Record<string, unknown>): string | undefined {
  if (!isMergedCodexDesktopCatalog(catalog)) return undefined;
  const path = getCodexDesktopModelCatalogPath();
  // Refresh the Install-managed file in place. Do not create a new catalog in a random
  // developer home just because a unit test called GET /v1/models.
  if (!existsSync(path) && !process.env.CODEX_HOME) return undefined;
  atomicWriteFile(path, serializeCodexDesktopModelCatalog(catalog));
  return path;
}

export async function augmentCatalogForCodexDesktop(
  nativeOrMerged: unknown,
  config: AppConfig,
): Promise<Record<string, unknown> | undefined> {
  let catalog: Record<string, unknown>;
  try {
    catalog = augmentNativeModelCatalog(
      nativeOrMerged,
      config,
      readCodexModelContextOverride(),
    );
  } catch {
    return undefined;
  }
  const routerConnection = (() => {
    try {
      return resolveCodexRouterConnection();
    } catch {
      return undefined;
    }
  })();
  if (routerConnection) {
    catalog = await augmentWithCodexRouterModels(catalog, config, routerConnection);
  }
  return isMergedCodexDesktopCatalog(catalog) ? catalog : undefined;
}

export async function resolveMergedCodexDesktopCatalog(
  config: AppConfig,
  options: { preferLocalBridge?: boolean } = {},
): Promise<Record<string, unknown> | undefined> {
  if (options.preferLocalBridge) {
    const bridged = await fetchLocalBridgeCatalog(config);
    if (bridged) {
      const merged = await augmentCatalogForCodexDesktop(bridged, config);
      if (merged) return merged;
    }
  }
  const native = readNativeCatalogFromModelsCache() ?? await fetchNativeCodexModels();
  if (!native) return undefined;
  return augmentCatalogForCodexDesktop(native, config);
}
