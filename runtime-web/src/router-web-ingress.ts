import { createHash } from "node:crypto";
import { isChatGptWebModelSlug } from "./chatgpt-web-models";

type JsonObject = Record<string, unknown>;
type ResponseHandler = (request: Request) => Promise<Response>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function modelSlug(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const slug = (value as JsonObject).slug;
  return typeof slug === "string" ? slug : undefined;
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

export function filterRouterWebCatalog(value: unknown): JsonObject {
  const catalog = object(value, "Coding Tools model catalog");
  if (!Array.isArray(catalog.models)) {
    throw new Error("Coding Tools model catalog is missing a models array");
  }
  return {
    ...structuredClone(catalog),
    models: catalog.models
      .filter(model => {
        const slug = modelSlug(model);
        return Boolean(slug && isChatGptWebModelSlug(slug));
      })
      .map(model => structuredClone(model)),
  };
}

export async function routerWebModelsResponse(source: Response): Promise<Response> {
  if (!source.ok) return source;
  let filtered: JsonObject;
  try {
    filtered = filterRouterWebCatalog(await source.json());
  } catch (error) {
    return Response.json({
      error: {
        type: "invalid_response_error",
        message: error instanceof Error ? error.message : String(error),
      },
    }, { status: 502 });
  }
  const body = JSON.stringify(filtered);
  const headers = new Headers(source.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  headers.set("etag", `W/\"${createHash("sha256").update(body).digest("base64url")}\"`);
  return new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers,
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
