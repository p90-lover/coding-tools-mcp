import type { AppConfig } from "./config";
import {
  availableChatGptWebModelRoutes,
  isChatGptWebModelSlug,
} from "./chatgpt-web-models";

type JsonObject = Record<string, unknown>;
type ResponseHandler = (request: Request) => Promise<Response>;

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
    raw = await request.clone().json();
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
  return handler(request);
}
