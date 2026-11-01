export type ChatGptRichKind = "image" | "file" | "audio" | "video" | "chart" | "app" | "artifact" | "diagram";

export interface ChatGptRichItem {
  kind: ChatGptRichKind;
  label: string;
  url?: string;
}

export interface ChatGptRichOutput {
  sourceUrl?: string;
  items: ChatGptRichItem[];
}

const kinds = new Set<ChatGptRichKind>(["image", "file", "audio", "video", "chart", "app", "artifact", "diagram"]);

function webUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 4_096 || /[\u0000-\u0020\u007f<>]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

function conversationUrl(value: unknown): string | undefined {
  const url = webUrl(value);
  if (!url || url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname)
    || !/^\/(?:g\/[^/]+\/)?c\/[^/]+\/?$/.test(url.pathname)) return undefined;
  return url.href;
}

/** Accept only portable web references. Authenticated ChatGPT downloads need the source view. */
function portableUrl(value: unknown): string | undefined {
  const url = webUrl(value);
  if (!url || ["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return undefined;
  return url.href;
}

/** The browser/helper boundary carries references, never captured HTML or executable code. */
export function normalizeChatGptRichOutput(value: unknown): ChatGptRichOutput | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.items)) return undefined;
  const items: ChatGptRichItem[] = [];
  const seen = new Set<string>();
  for (const item of candidate.items.slice(0, 128)) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (!kinds.has(raw.kind as ChatGptRichKind)) continue;
    const kind = raw.kind as ChatGptRichKind;
    const label = (typeof raw.label === "string" ? raw.label : kind)
      .replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || kind;
    const url = portableUrl(raw.url);
    const key = `${kind}\0${url ?? label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ kind, label, ...(url ? { url } : {}) });
    if (items.length === 32) break;
  }
  if (!items.length) return undefined;
  const sourceUrl = conversationUrl(candidate.sourceUrl);
  return { ...(sourceUrl ? { sourceUrl } : {}), items };
}

/** A new owned conversation replaces the previous one rather than inheriting its references. */
export function mergeChatGptRichOutputs(...values: unknown[]): ChatGptRichOutput | undefined {
  let result: ChatGptRichOutput | undefined;
  for (const value of values) {
    const next = normalizeChatGptRichOutput(value);
    if (!next) continue;
    if (result?.sourceUrl && next.sourceUrl && result.sourceUrl !== next.sourceUrl) result = undefined;
    result = normalizeChatGptRichOutput({
      sourceUrl: next.sourceUrl ?? result?.sourceUrl,
      items: [...(result?.items ?? []), ...next.items],
    });
  }
  return result;
}

function markdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[\[\]]/g, "\\$&").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Append once after text has completed; web-only views stay on their authenticated source. */
export function formatChatGptRichOutput(value: unknown, existingMarkdown = ""): string {
  const output = normalizeChatGptRichOutput(value);
  if (!output) return "";
  const parts = output.items.flatMap(item => {
    const label = markdownLabel(item.label);
    if (item.url) {
      if (existingMarkdown.includes(`](<${item.url}>)`) || existingMarkdown.includes(`](${item.url})`)) return [];
      const embed = ["image", "audio", "video"].includes(item.kind) ? "!" : "";
      return [`${embed}[${label}](<${item.url}>)`];
    }
    if (output.sourceUrl) return [`[Open ${label} in ChatGPT](<${output.sourceUrl}>)`];
    return [`${label} (${item.kind} preview unavailable: no retained ChatGPT source link.)`];
  });
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
