import { dshActivity, dshDuration, dshToolName, goalFeedback, type ChatLiveItem, type ChatTurn } from "./ao-chat";

/** The adapter's receipt joins all assistant messages. Keep their chronology, not two copies. */
export function transcriptParts(items: ChatLiveItem[], answer?: string): { items: ChatLiveItem[]; answer: string } {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  const said = flat(answer ?? "");
  if (!said) return { items, answer: answer ?? "" };
  const messages = items.filter((item) => item.kind === "message" && !item.answered && item.text.trim());
  const last = messages.at(-1);
  if (!last) return { items, answer: answer ?? "" };
  // Only a complete, matching receipt establishes that earlier messages belong outside the answer.
  // Substring matching discarded findings when the final answer happened to quote them.
  const joined = flat(messages.map((item) => item.text).join("\n\n"));
  if (joined === said) return { items: items.filter((item) => item !== last), answer: last.text };
  if (flat(last.text) === said) return { items: items.filter((item) => item !== last), answer: answer ?? "" };
  return { items, answer: answer ?? "" };
}

const FAILED = /^(failed|error|errored|denied|cancelled|canceled|rejected)$/i;
const SUCCEEDED = /^(completed|complete|done|success|succeeded)$/i;
const EXEC = new Set(["bash", "powershell", "pwsh", "shell", "exec_command", "terminal_run"]);
const noun = (count: number, one: string, many = `${one}s`) => `${count === 1 ? /^[aeiou]/i.test(one) ? "an" : "a" : count} ${count === 1 ? one : many}`;

/** Counts real invocations once; results, approvals and polling rows are not extra tools. */
export function transcriptSummary(items: ChatLiveItem[]) {
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const files = new Map<string, { path: string; additions: number; deletions: number }>();
  let commands = 0, reads = 0, searches = 0, edits = 0, toolCalls = 0, failed = 0;
  for (const item of unique) {
    if (!["command", "tool", "edit"].includes(item.kind)) continue;
    const bad = FAILED.test(item.status) || /^Denied\b/i.test(item.approval ?? "");
    if (bad) failed++;
    const call = /^(mcp|tool)$/i.test(item.label ?? "") ? { ...item, label: undefined } : item;
    const name = dshToolName(call);
    const activity = dshActivity(call);
    if (item.kind === "command" || EXEC.has(name)) commands++;
    else if (activity === "read") reads++;
    else if (activity === "search") searches++;
    else if (activity === "edit" || activity === "write") edits++;
    else toolCalls++;
    // A path in an input is not proof an edit happened. Only successful recorded file metadata is.
    if (bad || !SUCCEEDED.test(item.status)) continue;
    for (const file of item.files ?? []) {
      const key = file.path.replace(/\\/g, "/").replace(/^([a-z]):/i, (_, drive: string) => `${drive.toLowerCase()}:`);
      const known = files.get(key) ?? { path: file.path, additions: 0, deletions: 0 };
      known.additions += Number.isFinite(file.additions) ? Math.max(0, file.additions) : 0;
      known.deletions += Number.isFinite(file.deletions) ? Math.max(0, file.deletions) : 0;
      files.set(key, known);
    }
  }
  const parts = [
    files.size ? `edited ${noun(files.size, "file")}` : edits ? `made ${noun(edits, "edit")}` : "",
    commands ? `ran ${noun(commands, "command")}` : "",
    reads ? `read ${noun(reads, "file")}` : "",
    searches ? `${searches === 1 ? "searched code" : `searched code ${searches} times`}` : "",
    // Other tools are counted, not named: raw names ("listagents, sendmessage ×4") read as noise in
    // a one-line summary. The row's tooltip (activitySummary) and its open list still name each one.
    toolCalls ? `used ${noun(toolCalls, "tool")}` : "",
  ].filter(Boolean);
  const text = [parts.join(", ") || "No tool calls", failed ? `${failed} failed` : ""].filter(Boolean).join(" · ");
  const changed = [...files.values()];
  return { text: text[0].toUpperCase() + text.slice(1), files: changed, failed,
    additions: changed.reduce((total, file) => total + file.additions, 0),
    deletions: changed.reduce((total, file) => total + file.deletions, 0) };
}

/**
 * The colour family a work step is drawn in: what kind of work it was, not how it ended (a failed
 * step keeps its family and turns red on top). Native Codex steps carry only a label ("Edited",
 * "Web search"), and ACP's tool kinds arrive as labels too ("Thought", "Command", "Plan").
 */
export type StepFamily = "think" | "command" | "read" | "search" | "edit" | "web" | "plan" | "agent" | "ask" | "tool" | "approval" | "note";

export function stepFamily(item: ChatLiveItem): StepFamily {
  if (item.kind === "reasoning") return "think";
  if (item.kind === "approval") return "approval";
  if (item.kind === "user_input") return "ask";
  if (!["command", "tool", "edit"].includes(item.kind)) return "note";
  const label = (item.label ?? "").trim().toLowerCase();
  if (label === "edited" || label === "created") return "edit";
  if (label === "web search") return "web";
  if (label === "thought") return "think";
  if (label === "command") return "command";
  if (label === "plan") return "plan";
  // "MCP" and "Tool" say nothing about the work; the tool's own name does.
  const call = label === "mcp" || label === "tool" ? { ...item, label: undefined } : item;
  switch (dshActivity(call)) {
    case "commands": case "code": return "command";
    case "read": case "readImage": return "read";
    case "search": return "search";
    case "edit": case "write": return "edit";
    case "webSearch": case "webFetch": return "web";
    case "plan": return "plan";
    case "subagents": return "agent";
    case "questions": return "ask";
    default: return "tool";
  }
}

/** The families a work fold's chips count, in the order they read best. */
const FAMILY_ORDER: StepFamily[] = ["think", "read", "search", "command", "edit", "web", "tool", "agent", "plan", "ask"];
const FAMILY_NOUN: Record<StepFamily, [string, string]> = {
  think: ["thought", "thoughts"], command: ["command", "commands"], read: ["read", "reads"], search: ["search", "searches"],
  edit: ["edit", "edits"], web: ["web lookup", "web lookups"], plan: ["plan update", "plan updates"], agent: ["subagent", "subagents"],
  ask: ["question", "questions"], tool: ["tool call", "tool calls"], approval: ["approval", "approvals"], note: ["note", "notes"],
};
export const stepFamilyNoun = (family: StepFamily, count: number) => `${count} ${FAMILY_NOUN[family][count === 1 ? 0 : 1]}`;

/** Each family's steps in a stretch of work, counted once per step, plus how many of them failed. */
export function stepFamilyCounts(items: ChatLiveItem[]): { family: StepFamily; count: number; failed: number }[] {
  const counts = new Map<StepFamily, { count: number; failed: number }>();
  for (const item of new Map(items.map((entry) => [entry.id, entry])).values()) {
    if (!["command", "tool", "edit", "reasoning"].includes(item.kind)) continue;
    const family = stepFamily(item);
    const known = counts.get(family) ?? { count: 0, failed: 0 };
    known.count += 1;
    if (FAILED.test(item.status) || /^Denied\b/i.test(item.approval ?? "")) known.failed += 1;
    counts.set(family, known);
  }
  return FAMILY_ORDER.filter((family) => counts.has(family)).map((family) => ({ family, ...counts.get(family)! }));
}

/** A step's time as the row shows it: tenths under ten seconds ("0.4s", "3.2s"), then "42s", "1m 53s". */
export function stepDuration(ms?: number): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return "";
  const tenths = Math.round(Math.max(ms, 100) / 100) / 10;
  if (tenths < 10) return `${tenths.toFixed(1)}s`;
  return ms < 59_500 ? `${Math.round(ms / 1000)}s` : dshDuration(ms);
}

/**
 * An opened thought's two parts: the title its row keeps and the words under it. A thought that
 * starts on a bold title line ("**Inspecting the register route**", as reasoning summaries come)
 * keeps the title on its row and the rest below, so an open thought never says its title twice;
 * one without a title shows all of its words below.
 */
export function openedThought(text: string): { title: string; body: string } {
  const trimmed = text.trim();
  const titled = /^\*\*([^\n]+?)\*\*[ \t]*(?:\r?\n|$)/.exec(trimmed);
  if (!titled) return { title: "", body: trimmed };
  return { title: titled[1].replace(/[*_`]/g, "").trim(), body: trimmed.slice(titled[0].length).trim() };
}

/**
 * Where the mission of a goal being pursued starts among a chat's turns: the message that set the
 * goal (its round 1), after which every turn is one of its rounds: the goal's own feedback
 * (goalFeedback), or a restart of a round, which has no message of its own. The newest turn while
 * the goal is in its first round; -1 for a chat with no turns.
 */
export function goalMissionStart(turns: Pick<ChatTurn, "user">[]): number {
  let start = turns.length - 1;
  while (start > 0 && (!turns[start].user || goalFeedback(turns[start].user!.text))) start -= 1;
  return start;
}

/** How a turn's work ended, for the colour of its "Worked for" line (transcriptCompletion's words). */
export function transcriptTone(turn: ChatTurn): "failed" | "stopped" | "waiting" | "done" | "working" {
  const steps = [...turn.steps, ...(turn.final ? [turn.final] : [])];
  if (steps.some((step) => step.error)) return "failed";
  if (turn.status === "stopped") return "stopped";
  if (turn.status === "attention" || turn.status === "paused") return "waiting";
  return turn.status === "done" ? "done" : "working";
}

/** Ending a model turn is not evidence that the person's mission or goal succeeded. */
export function transcriptCompletion(turn: ChatTurn): string {
  const steps = [...turn.steps, ...(turn.final ? [turn.final] : [])];
  const time = turn.startedAtMs && turn.endedAtMs && turn.endedAtMs > turn.startedAtMs ? dshDuration(turn.endedAtMs - turn.startedAtMs) : "";
  // Codex's words for folded work: "Worked for 1m 53s", or how it stopped short.
  if (steps.some((step) => step.error)) return time ? `Failed after ${time}` : "Failed";
  if (turn.status === "stopped") return time ? `Stopped after ${time}` : "Stopped";
  if (turn.status === "attention" || turn.status === "paused") return time ? `Waiting for input · ${time}` : "Waiting for input";
  if (turn.status === "done") return time ? `Worked for ${time}` : "Worked";
  return "Working";
}
