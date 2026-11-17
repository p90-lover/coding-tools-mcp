import { CHAT_STYLE_KEY, CHAT_STYLES, type ChatStyle } from "./chat-reply-plan";

export type ResponseStyle = ChatStyle | "auto";
export type ResponseStyleScope = "global" | "provider" | "model" | "chat";
export type ResponseStyleContext = { provider?: string; model?: string; chat?: string };
export type ResponseStylePreferences = { version: 1; global?: ResponseStyle; providers: Record<string, ResponseStyle>;
  models: Record<string, ResponseStyle>; chats: Record<string, ResponseStyle> };
export const RESPONSE_STYLE_KEY = "coding-tools:ao:response-style:v1";
const CHANGED = "coding-tools:response-style";
const MAX_RULES = 1000;
let session: ResponseStylePreferences | null = null;

export const RESPONSE_STYLES: { id: ResponseStyle; label: string; hint: string }[] = [
  { id: "auto", label: "Automatic", hint: "Use the model default: DeepSeek for DeepSeek models, Transcript otherwise" },
  ...CHAT_STYLES,
];
const validStyle = (value: unknown): value is ResponseStyle => RESPONSE_STYLES.some(style => style.id === value);
const identifier = (value: unknown): string => typeof value === "string" && value.length <= 512
  && value.trim() && !/[\u0000-\u001f]/.test(value) ? value.trim() : "";
const ownStyle = (rules: Record<string, ResponseStyle>, key?: string) => key && Object.hasOwn(rules, key) ? rules[key] : undefined;
const empty = (): ResponseStylePreferences => ({ version: 1, providers: {}, models: {}, chats: {} });
const rules = (value: unknown): Record<string, ResponseStyle> => !value || typeof value !== "object" || Array.isArray(value) ? {}
  : Object.fromEntries(Object.entries(value).slice(0, MAX_RULES).filter(([key, style]) => key.length <= 2048
    && key.trim() === key && key.length > 0 && !/[\u0000-\u001f]/.test(key) && validStyle(style)));

/** Route identity is presentation-only: never rewrite the agent's route to choose a renderer. */
export function responseStyleContext(route?: { model?: string; provider_id?: string; harness_id?: string }, chat?: string, cpaProvider?: string | null): ResponseStyleContext {
  const model = identifier(route?.model);
  let provider = identifier(route?.provider_id);
  if (model.startsWith("cpa/")) {
    const parts = model.slice(4).split("/");
    const source = identifier(cpaProvider) || (parts.length > 1 ? parts[0] : "");
    provider = source ? `cpa/${source}` : "";
  } else if (!provider && model) {
    provider = model.includes("/") ? model.split("/")[0] : identifier(route?.harness_id);
  }
  return { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(identifier(chat) ? { chat: identifier(chat) } : {}) };
}
export function responseModelKey(context: ResponseStyleContext): string | undefined {
  const provider = identifier(context.provider), model = identifier(context.model);
  return provider && model ? JSON.stringify([provider, model]) : undefined;
}

export function readResponseStyles(): ResponseStylePreferences {
  if (session) return structuredClone(session);
  try {
    const raw = localStorage.getItem(RESPONSE_STYLE_KEY);
    let parsed;
    try { parsed = raw && raw.length <= 1_000_000 ? JSON.parse(raw) : null; } catch { parsed = null; }
    const saved = parsed?.version === 1 ? { version: 1 as const, ...(validStyle(parsed.global) ? { global: parsed.global } : {}),
      providers: rules(parsed.providers), models: rules(parsed.models), chats: rules(parsed.chats) } : empty();
    if (saved.global === undefined) {
      const legacy = localStorage.getItem(CHAT_STYLE_KEY);
      if (validStyle(legacy)) saved.global = legacy;
    }
    return saved;
  } catch { return empty(); }
}

export function responseStyleOverride(preferences: ResponseStylePreferences, scope: ResponseStyleScope, context: ResponseStyleContext): ResponseStyle | undefined {
  if (scope === "global") return preferences.global;
  return ownStyle(scope === "provider" ? preferences.providers : scope === "model" ? preferences.models : preferences.chats,
    scope === "provider" ? context.provider : scope === "model" ? responseModelKey(context) : context.chat);
}
export function resolveResponseStyle(preferences: ResponseStylePreferences, context: ResponseStyleContext): { style: ChatStyle; choice: ResponseStyle; source: ResponseStyleScope | "default" } {
  const scopes: ResponseStyleScope[] = ["chat", "model", "provider", "global"];
  for (const source of scopes) {
    const choice = responseStyleOverride(preferences, source, context);
    if (choice !== undefined) return { choice, source, style: choice === "auto" ? (/deepseek/i.test(context.model ?? "") ? "deepseek" : "transcript") : choice };
  }
  return { choice: "auto", source: "default", style: /deepseek/i.test(context.model ?? "") ? "deepseek" : "transcript" };
}

export function saveResponseStyle(scope: ResponseStyleScope, context: ResponseStyleContext, style: ResponseStyle | null): { preferences: ResponseStylePreferences; persisted: boolean } {
  if (style !== null && !validStyle(style)) throw new Error("Unknown response style");
  const next = readResponseStyles();
  if (scope === "global") {
    // Explicit Automatic prevents an old global key from reappearing when reset.
    next.global = style ?? "auto";
  } else {
    const key = scope === "provider" ? identifier(context.provider) : scope === "model" ? responseModelKey(context) : identifier(context.chat);
    if (!key) throw new Error(`Choose a ${scope === "model" ? "provider and model" : scope} first`);
    const field = scope === "provider" ? "providers" : scope === "model" ? "models" : "chats";
    const entries = Object.entries(next[field]).filter(([id]) => id !== key);
    if (style !== null) entries.push([key, style]);
    next[field] = Object.fromEntries(entries.slice(-MAX_RULES));
  }
  let persisted = false;
  try {
    const encoded = JSON.stringify({ version: 1, global: next.global, providers: next.providers, models: next.models, chats: next.chats });
    if (localStorage.getItem(RESPONSE_STYLE_KEY) !== encoded) localStorage.setItem(RESPONSE_STYLE_KEY, encoded);
    session = null; persisted = true;
  }
  catch { session = next; }
  try { window.dispatchEvent(new Event(CHANGED)); } catch { /* no window in pure tests */ }
  return { preferences: structuredClone(next), persisted };
}

export function onResponseStyles(listener: (preferences: ResponseStylePreferences) => void): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => {};
  const local = () => listener(readResponseStyles());
  const storage = (event: StorageEvent) => {
    if (event.key === RESPONSE_STYLE_KEY || event.key === CHAT_STYLE_KEY || event.key === null) { session = null; local(); }
  };
  window.addEventListener(CHANGED, local);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(CHANGED, local); window.removeEventListener("storage", storage); };
}
