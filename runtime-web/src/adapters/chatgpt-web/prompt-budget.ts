import type { CodexContentPart, CodexMessage, CodexToolResultMessage } from "../../types";

/**
 * WebGPT turns paste the whole Codex history into the ChatGPT composer, so every old command
 * output is re-sent on every turn and the page slows down as a task grows. The most recent tool
 * results stay complete; older large ones keep their beginning and end, which is where commands
 * report what they did and how they ended. The model can rerun a command if it needs the middle.
 */
export const RECENT_TOOL_RESULTS_KEPT_WHOLE = 6;
export const OLD_TOOL_RESULT_CHAR_LIMIT = 4_000;
const OLD_TOOL_RESULT_HEAD_CHARS = 2_500;
const OLD_TOOL_RESULT_TAIL_CHARS = 1_000;

function trimmedText(text: string): string {
  if (text.length <= OLD_TOOL_RESULT_CHAR_LIMIT) return text;
  const omitted = text.length - OLD_TOOL_RESULT_HEAD_CHARS - OLD_TOOL_RESULT_TAIL_CHARS;
  return `${text.slice(0, OLD_TOOL_RESULT_HEAD_CHARS)}\n[… ${omitted.toLocaleString("en-US")} characters of this earlier tool output omitted to keep the browser prompt small; rerun the command if they are needed …]\n${text.slice(-OLD_TOOL_RESULT_TAIL_CHARS)}`;
}

function trimmedResult(message: CodexToolResultMessage): CodexToolResultMessage {
  if (typeof message.content === "string") {
    const content = trimmedText(message.content);
    return content === message.content ? message : { ...message, content };
  }
  let changed = false;
  const content = message.content.map((part): CodexContentPart => {
    if (part.type !== "text") return part;
    const text = trimmedText(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? { ...message, content } : message;
}

/** Shortens large tool results older than the most recent few; everything else is unchanged. */
export function withTrimmedOldToolResults(messages: CodexMessage[]): CodexMessage[] {
  let recentSeen = 0;
  let changed = false;
  const result = [...messages];
  for (let index = result.length - 1; index >= 0; index -= 1) {
    const message = result[index]!;
    if (message.role !== "toolResult") continue;
    recentSeen += 1;
    if (recentSeen <= RECENT_TOOL_RESULTS_KEPT_WHOLE) continue;
    const trimmed = trimmedResult(message);
    if (trimmed !== message) { result[index] = trimmed; changed = true; }
  }
  return changed ? result : messages;
}
