import type { CodingToolsApi } from "./contracts";

export function getCodingToolsClient(): CodingToolsApi {
  const client = window.codingTools;
  if (!client) throw new Error("CODING_TOOLS_PRELOAD_UNAVAILABLE");
  return client;
}
