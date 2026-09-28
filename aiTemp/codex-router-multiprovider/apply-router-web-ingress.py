from pathlib import Path

path = Path("runtime-web/src/server.ts")
text = path.read_text(encoding="utf-8")

import_anchor = '''} from "./routed-providers";\nimport { VERSION } from "./version";\n'''
import_replacement = '''} from "./routed-providers";\nimport {\n  routeRouterWebResponse,\n  routerWebModelsResponse,\n} from "./router-web-ingress";\nimport { VERSION } from "./version";\n'''
if 'from "./router-web-ingress"' not in text:
    if import_anchor not in text:
        raise SystemExit("router web ingress import anchor missing")
    text = text.replace(import_anchor, import_replacement, 1)

route_anchor = '''      if (req.method === "GET" && url.pathname === "/v1/models") {\n'''
route_block = '''      if (req.method === "GET" && url.pathname === "/router/v1/models") {\n        if (draining) {\n          return formatErrorResponse(\n            503,\n            "server_error",\n            "codex-chatgpt-web is draining for a requested service operation",\n          );\n        }\n        try {\n          return routerWebModelsResponse(config);\n        } catch (error) {\n          return formatErrorResponse(\n            500,\n            "server_error",\n            error instanceof Error ? error.message : String(error),\n          );\n        }\n      }\n      if (req.method === "POST" && url.pathname === "/router/v1/responses") {\n        if (draining) {\n          return formatErrorResponse(\n            503,\n            "server_error",\n            "codex-chatgpt-web is draining for a requested service operation",\n          );\n        }\n        return httpTurns.track(\n          (signal, bindIdentity) => routeRouterWebResponse(\n            new Request(req, { signal }),\n            routedRequest => responseRequest(\n              routedRequest,\n              config,\n              dependencies.adapterFactory,\n              { onTurnIdentity: bindIdentity },\n            ),\n          ),\n          req.signal,\n          process.platform,\n          "responses",\n        );\n      }\n      if (req.method === "GET" && url.pathname === "/v1/models") {\n'''
if 'url.pathname === "/router/v1/models"' not in text:
    if route_anchor not in text:
        raise SystemExit("router web ingress route anchor missing")
    text = text.replace(route_anchor, route_block, 1)

path.write_text(text, encoding="utf-8")
print("ROUTER_WEB_INGRESS_SERVER_PATCH_OK")
