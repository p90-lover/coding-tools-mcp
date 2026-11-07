import { dshActivity, dshDuration, dshToolName, type ChatLiveItem, type ChatTurn } from "./ao-chat";

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
  const tools = new Map<string, number>();
  let commands = 0, reads = 0, searches = 0, edits = 0, failed = 0;
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
    else tools.set(name || "tool", (tools.get(name || "tool") ?? 0) + 1);
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
    ...[...tools].slice(0, 3).map(([name, count]) => count > 1 ? `${name} ×${count}` : name),
    tools.size > 3 ? `${tools.size - 3} more tools` : "",
  ].filter(Boolean);
  const text = [parts.join(", ") || "No tool calls", failed ? `${failed} failed or denied` : ""].filter(Boolean).join(" · ");
  const changed = [...files.values()];
  return { text: text[0].toUpperCase() + text.slice(1), files: changed, failed,
    additions: changed.reduce((total, file) => total + file.additions, 0),
    deletions: changed.reduce((total, file) => total + file.deletions, 0) };
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
