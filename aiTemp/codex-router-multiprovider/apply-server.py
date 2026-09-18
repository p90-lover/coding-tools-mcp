from pathlib import Path

path = Path("runtime-web/src/server.ts")
text = path.read_text(encoding="utf-8")

import_anchor = 'import { VERSION } from "./version";\n'
import_block = '''import {
  augmentWithCodexRouterModels,
  forwardCodexRouterResponse,
  parseCodexRouterModelId,
  resolveCodexRouterConnection,
} from "./routed-providers";
import { VERSION } from "./version";
'''
if 'from "./routed-providers"' not in text:
    if import_anchor not in text:
        raise SystemExit("server import anchor missing")
    text = text.replace(import_anchor, import_block, 1)

catalog_anchor = '    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());\n'
catalog_block = '''    catalog = augmentNativeModelCatalog(await upstream.json(), config, contextOverride?.());
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
'''
if 'augmentWithCodexRouterModels(catalog, config, routerConnection)' not in text:
    if catalog_anchor not in text:
        raise SystemExit("model catalog anchor missing")
    text = text.replace(catalog_anchor, catalog_block, 1)

native_anchor = '''  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
'''
routed_block = '''  if (typeof requestedModel === "string" && parseCodexRouterModelId(requestedModel)) {
    let routerConnection;
    try {
      routerConnection = resolveCodexRouterConnection();
    } catch (error) {
      return formatErrorResponse(
        400,
        "invalid_request_error",
        error instanceof Error ? error.message : "Invalid Codex Router configuration",
      );
    }
    if (!routerConnection) {
      return formatErrorResponse(
        503,
        "upstream_error",
        "Codex Router is not configured for this Coding Tools runtime",
      );
    }
    try {
      return await forwardCodexRouterResponse(
        req,
        raw as Record<string, unknown>,
        routerConnection,
      );
    } catch (error) {
      return formatErrorResponse(
        502,
        "upstream_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (typeof requestedModel === "string" && !isChatGptWebModelSlug(requestedModel)) {
'''
if 'Codex Router is not configured for this Coding Tools runtime' not in text:
    if native_anchor not in text:
        raise SystemExit("native response route anchor missing")
    text = text.replace(native_anchor, routed_block, 1)

path.write_text(text, encoding="utf-8")
print("ROUTED_PROVIDER_SERVER_PATCH_OK")
