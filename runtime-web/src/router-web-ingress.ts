import type { AppConfig } from "./config";
import {
  availableChatGptWebModelRoutes,
  isChatGptWebModelSlug,
} from "./chatgpt-web-models";
import { readJsonRequestBody } from "./http-body";

type JsonObject = Record<string, unknown>;
type ResponseHandler = (request: Request, decodedBody: JsonObject) => Promise<Response>;

export interface RouterWebModelEntry {
  id: string;
  object: "model";
  owned_by: "coding-tools-web";
}

export interface RouterWebModelCatalog {
  object: "list";
  data: RouterWebModelEntry[];
}

function invalidRequest(message: string): Response {
  return Response.json({
    error: {
      type: "invalid_request_error",
      message,
    },
  }, {
    status: 400,
    headers: { "cache-control": "no-store" },
  });
}

export function routerWebModelCatalog(config: AppConfig): RouterWebModelCatalog {
  const data = availableChatGptWebModelRoutes(config).map(route => ({
    id: route.slug,
    object: "model" as const,
    owned_by: "coding-tools-web" as const,
  }));
  return { object: "list", data };
}

export function routerWebModelsResponse(config: AppConfig): Response {
  return Response.json(routerWebModelCatalog(config), {
    status: 200,
    headers: {
      "cache-control": "no-store",
    },
  });
}

export async function routeRouterWebResponse(
  request: Request,
  handler: ResponseHandler,
): Promise<Response> {
  let raw: unknown;
  try {
    // Decode through the same bounded and encoding-aware path as the main Responses handler. The
    // validated object is passed downstream directly, so large Codex histories are never cloned,
    // decompressed, decoded, or JSON-parsed a second time at this ingress boundary.
    raw = await readJsonRequestBody(request);
  } catch {
    return invalidRequest("Coding Tools Web router ingress requires a JSON object with a chatgpt-web/* model");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidRequest("Coding Tools Web router ingress requires a JSON object with a chatgpt-web/* model");
  }
  const model = (raw as JsonObject).model;
  if (typeof model !== "string" || !isChatGptWebModelSlug(model)) {
    return invalidRequest(
      "Coding Tools Web router ingress accepts only explicitly selected chatgpt-web/* models",
    );
  }
  return handler(request, raw as JsonObject);
}
