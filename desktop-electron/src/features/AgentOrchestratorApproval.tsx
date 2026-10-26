import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChatMarkdown } from "./ChatMarkdown";
import { ModelJudgesToggle } from "./ModelJudgesToggle";

// The agent's questions and tool requests as the Codex desktop app asks them (its approval card and
// request_user_input card, from the app's own markup and words, with "ChatGPT" read as the card's
// agent): a 24px card, a kind line, the question, numbered options to pick and change, then one
// Submit. Enter submits and Escape dismisses or denies, as Codex's hotkeys do.

/** A key chip as Codex draws one beside a button ("Esc", "Enter"). */
const Kbd = ({ children }: { children: ReactNode }) => <kbd className="cdx-kbd">{children}</kbd>;

/** Codex's numbered choices: a box with the number (filled when picked), the label, its description. */
function CdxOptions({ options, picked, multi, onPick, name, disabled }: {
  options: { value: string; label: string; description?: string }[]; picked: string[]; multi?: boolean;
  onPick: (value: string) => void; name: string; disabled?: boolean;
}) {
  return <div className="cdx-options" role={multi ? "group" : "radiogroup"} aria-label={name}>
    {options.map((option, index) => {
      const selected = picked.includes(option.value);
      // A trailing " (Recommended)" becomes Codex's badge.
      const recommended = /\s*\(recommended\)\s*$/i.test(option.label);
      const label = option.label.replace(/\s*\(recommended\)\s*$/i, "");
      return <button key={option.value} type="button" className={`cdx-option${selected ? " is-selected" : ""}`}
        role={multi ? "checkbox" : "radio"} aria-checked={selected} disabled={disabled} onClick={() => onPick(option.value)}>
        {options.length > 1 ? <span className="cdx-option-mark" aria-hidden="true">{index + 1}</span> : null}
        <span className="cdx-option-label">{label}</span>
        {recommended ? <span className="cdx-badge">Recommended</span> : null}
        {option.description ? <span className="cdx-option-description">{option.description}</span> : null}
      </button>;
    })}
  </div>;
}

/** Keys on a card: a number picks that option, Enter submits, Escape dismisses or denies. */
function cardKeys(event: KeyboardEvent<HTMLElement>, count: number, pick: (index: number) => void, submit: () => void, dismiss: () => void) {
  const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
  if (event.key === "Escape") { event.preventDefault(); dismiss(); return; }
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); return; }
  if (!typing && /^[1-9]$/.test(event.key) && Number(event.key) <= count) { event.preventDefault(); pick(Number(event.key) - 1); }
}

/** Focuses the card when it appears, unless the person is typing somewhere (the composer). */
function useCardFocus() {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement | null)?.isContentEditable) return;
    card.current?.focus({ preventScroll: true });
  }, []);
  return card;
}

export type AoApproval = {
  nodeId: string; approval_id: string; kind?: string; method?: string; path?: string; reason?: string; command?: string; cwd?: string;
  thread_id?: string; turn_id?: string; item_id?: string; request?: Record<string, unknown>;
  permissions?: Record<string, unknown>; seconds_remaining?: number;
  recommendation?: { action: "allow" | "deny" | "ask"; reason: string };
  /** "Approve for me": the reviewer is checking it, or has answered and is sending its answer. */
  awaiting_review?: boolean;
  /** An AO agent's parked tool request (e.g. Claude Code's Bash): its tool name and AO's summary. */
  source?: "ao"; tool?: string; summary?: string;
  /** The decisions the AO agent offered; `plan` is the plan of an ExitPlanMode request. */
  decisions?: { id: string; kind: string; label: string }[]; plan?: string; since?: string;
  /** An MCP tool's arguments, as JSON (what read_file reads, what search_text looks for). */
  toolInput?: string;
  /** What an install command does to the project's own packages (see dependencyInstallNote). */
  dependencyNote?: { tone: "warn" | "info"; text: string };
  /** A question the AO agent asked (kind "question"): its message, form fields or a URL to visit. */
  message?: string; mode?: "form" | "url"; url?: string; fields?: QuestionField[];
};
/** One field of an AO agent's question; `customKey` is the free-text "Other" answer's own field. */
export type QuestionField = {
  key: string; type: "choice" | "multi" | "text" | "boolean" | "number"; title: string; description: string;
  options: { value: string; label: string; description: string }[]; customKey?: string; required?: boolean;
};

/**
 * A question the AO agent asked (Claude Code's AskUserQuestion), answered in the chat: one choice,
 * several, or the person's own words for each, then sent back as the agent's form expects.
 */
function AoQuestion({ approval, busy, approve }: { approval: AoApproval; busy: boolean; approve: (approval: AoApproval, reply: ApprovalReply) => void }) {
  const fields = approval.fields ?? [];
  const [values, setValues] = useState<Record<string, string | string[] | boolean>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const set = (key: string, value: string | string[] | boolean) => setValues((current) => ({ ...current, [key]: value }));
  const answered = (field: QuestionField) => {
    const value = values[field.key];
    return Boolean((field.customKey && other[field.key]?.trim()) || (Array.isArray(value) ? value.length : value !== undefined && value !== ""));
  };
  const ready = fields.every((field) => !field.required || answered(field));
  const send = () => {
    if (busy || !ready) return;
    const content: Record<string, unknown> = {};
    for (const field of fields) {
      const value = values[field.key];
      if (field.customKey && other[field.key]?.trim()) content[field.customKey] = other[field.key].trim();
      if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) continue;
      content[field.key] = field.type === "number" ? Number(value) : value;
    }
    approve(approval, { action: "accept", content });
  };
  const dismiss = () => { if (!busy) approve(approval, { action: "decline" }); };
  // Codex asks one question at a time, "‹ 1 of 3 ›" between them; answers stay as you move.
  const [at, setAt] = useState(0);
  const card = useCardFocus();
  const field = fields[Math.min(at, Math.max(0, fields.length - 1))];
  const last = at >= fields.length - 1;
  const pick = (value: string) => {
    if (!field) return;
    if (field.type === "multi") {
      const list = Array.isArray(values[field.key]) ? values[field.key] as string[] : [];
      set(field.key, list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]);
    } else set(field.key, value);
  };
  const next = () => (last ? send() : setAt(at + 1));
  if (approval.mode === "url") {
    return <div ref={card} tabIndex={-1} className="cdx-card" role="alert" aria-label="The agent's question"
      onKeyDown={(event) => cardKeys(event, 0, () => undefined, () => approve(approval, { action: "accept" }), dismiss)}>
      <div className="cdx-body">
        <span className="cdx-title">{approval.message || "The agent asks you to visit a page"}</span>
        {approval.url ? <a className="cdx-link" href={approval.url} target="_blank" rel="noreferrer">{approval.url}</a> : <p className="cdx-reason">The page address is unavailable.</p>}
      </div>
      <div className="cdx-foot">
        <button type="button" className="cdx-button is-ghost" disabled={busy} onClick={dismiss}>Dismiss <Kbd>ESC</Kbd></button>
        <button type="button" className="cdx-button is-primary" disabled={busy} onClick={() => approve(approval, { action: "accept" })}>Submit <Kbd>Enter</Kbd></button>
      </div>
    </div>;
  }
  const title = field ? field.description || field.title || approval.message || "Question" : approval.message || "Question";
  const options = field && (field.type === "choice" || field.type === "multi") ? field.options
    : field?.type === "boolean" ? [{ value: "true", label: "Yes", description: "" }, { value: "false", label: "No", description: "" }] : [];
  const picked = !field ? [] : field.type === "boolean" ? (values[field.key] === undefined ? [] : [String(values[field.key])])
    : Array.isArray(values[field.key]) ? values[field.key] as string[] : values[field.key] !== undefined ? [String(values[field.key])] : [];
  const entered = field ? answered(field) : false;
  return <div ref={card} tabIndex={-1} className="cdx-card" role="alert" aria-label="The agent's question"
    onKeyDown={(event) => cardKeys(event, options.length, (index) => {
      if (!field) return;
      if (field.type === "boolean") set(field.key, index === 0); else pick(options[index].value);
    }, () => (entered || !field?.required ? next() : undefined), dismiss)}>
    <div className="cdx-body">
      <div className="cdx-question-head">
        <span className="cdx-title">{title}</span>
        {fields.length > 1 ? <span className="cdx-progress">
          <button type="button" className="cdx-icon" aria-label="Previous question" disabled={at === 0} onClick={() => setAt(at - 1)}>‹</button>
          {at + 1} of {fields.length}
          <button type="button" className="cdx-icon" aria-label="Next question" disabled={last} onClick={() => setAt(at + 1)}>›</button>
        </span> : null}
      </div>
      {approval.message && approval.message !== title ? <div className="cdx-message"><ChatMarkdown text={approval.message} /></div> : null}
      {field && field.title && field.description && field.title !== title ? <span className="cdx-reason">{field.title}</span> : null}
      {options.length ? <CdxOptions name={title} options={options} picked={picked} multi={field?.type === "multi"}
        onPick={(value) => (field?.type === "boolean" ? set(field.key, value === "true") : pick(value))} /> : null}
      {field && (field.type === "text" || field.type === "number") ? <input className="cdx-input" type={field.type === "number" ? "number" : "text"}
        aria-label={title} placeholder="Type here" value={String(values[field.key] ?? "")} onChange={(event) => set(field.key, event.target.value)} /> : null}
      {field?.customKey ? <input className="cdx-input" type="text" aria-label={`${title}: other`} placeholder="Type here"
        value={other[field.key] ?? ""} onChange={(event) => setOther((current) => ({ ...current, [field.key]: event.target.value }))} /> : null}
    </div>
    <div className="cdx-foot">
      <button type="button" className="cdx-button is-ghost" disabled={busy} title="Skip answering. The agent goes on without it." onClick={dismiss}>
        Dismiss <Kbd>ESC</Kbd></button>
      {/* Codex: "Skip" while nothing is entered, then "Next" or, on the last question, "Submit". */}
      {!entered && !field?.required
        ? <button type="button" className="cdx-button is-outline" disabled={busy || (last && !ready)} onClick={next}>Skip</button>
        : <button type="button" className="cdx-button is-primary" disabled={busy || (last ? !ready : !entered)} onClick={next}>
          {last ? "Submit" : "Next"} <Kbd>Enter</Kbd></button>}
    </div>
  </div>;
}
/** Codex's words for the answers an AO request offers (AO names them by kind). */
const DECISION_WORDS: Record<string, string> = {
  allow_once: "Allow once", allow_always: "Allow this conversation", reject_once: "Deny", reject_always: "Always deny",
};
const NATIVE_DECISION_WORDS: Record<string, string> = {
  accept: "Allow once", acceptForSession: "Allow this conversation", decline: "Deny", cancel: "Cancel",
};
const EDIT_TOOL = /^(?:Edit|MultiEdit|Write|NotebookEdit|str_replace_based_edit_tool|apply_patch)$/i;
const SHELL_TOOL = /(?:^|__)(?:Bash|PowerShell|exec_command|shell|run_terminal_cmd)$/i;

/** The exact request stays readable without changing the approval or its keyboard shortcuts. */
function ApprovalCode({ text, label }: { text: string; label: string }) {
  return <pre className="cdx-command" tabIndex={0} role="region" aria-label={label}
    onKeyDown={(event) => event.stopPropagation()}>{text}</pre>;
}

/**
 * A tool request from an AO agent as Codex's approval card asks it: "Terminal" / "Edit files" /
 * "Ask permission", "Allow {agent} to run this command?", the complete command in a scrollable box, the
 * reason (and the reviewer's, when it left it to you), then the answers the agent offered as
 * numbered options. As in Claude Code's permission prompt, clicking one (or pressing its number)
 * answers at once: no Submit or Deny button. Escape answers Deny.
 */
function AoAsk({ approval, busy, approve, actor }: {
  approval: AoApproval; busy: boolean; approve: (approval: AoApproval, reply: ApprovalReply) => void; actor: string;
}) {
  const tool = String(approval.tool ?? "").replace(/^mcp__[\w-]+__/, "");
  const shell = approval.kind === "command" || Boolean(approval.command) || SHELL_TOOL.test(String(approval.tool ?? ""));
  const edit = !shell && (EDIT_TOOL.test(tool) || approval.kind === "file_change");
  const kindLine = shell ? "Terminal" : edit ? "Edit files" : "Ask permission";
  const title = shell ? `Allow ${actor} to run this command?` : edit ? `Allow ${actor} to edit the following file?` : `Allow ${actor} to use ${tool || "this tool"}?`;
  const shellInput = shell ? (() => { try { const input = JSON.parse(approval.toolInput ?? ""); return typeof input?.cmd === "string" ? input.cmd : typeof input?.command === "string" ? input.command : ""; } catch { return ""; } })() : "";
  const body = approval.command || shellInput || approval.toolInput || approval.path || "";
  const offered = (approval.decisions ?? []).length ? approval.decisions!
    : [{ id: "allow", kind: "allow_once", label: "Allow once" }, { id: "deny", kind: "reject_once", label: "Deny" }];
  const options = offered.map((decision) => ({ value: decision.id, label: DECISION_WORDS[decision.kind] ?? decision.label }));
  // The answer sent, shown picked until the card goes; a second click (or key) sends nothing.
  const [sent, setSent] = useState<string | null>(null);
  const card = useCardFocus();
  const send = (id: string | null) => {
    if (busy || sent || !id) return;
    setSent(id);
    if (!(approval.decisions ?? []).length) { approve(approval, id === "allow"); return; }
    approve(approval, { decisionId: id });
  };
  const denyId = offered.find((decision) => decision.kind === "reject_once")?.id ?? offered.find((decision) => decision.kind.startsWith("reject"))?.id ?? null;
  const reason = approval.reason && approval.reason !== approval.summary ? approval.reason : approval.summary && approval.summary !== tool ? approval.summary : "";
  return <div ref={card} tabIndex={-1} className="cdx-card" role="alert" aria-label={title}
    onKeyDown={(event) => cardKeys(event, options.length, (index) => send(options[index].value), () => undefined, () => send(denyId))}>
    <div className="cdx-body">
      <span className="cdx-kind">{kindLine}</span>
      <span className="cdx-title">{title}</span>
      {body ? <ApprovalCode text={body} label={shell ? "Command" : "Tool input"} /> : null}
      {reason ? <div className="cdx-row"><span>Reason</span><p>{reason}</p></div> : null}
      {approval.recommendation?.reason ? <div className="cdx-row"><span>Reviewer</span><p>{approval.recommendation.reason}</p></div> : null}
      {/* The reviewer left it to you: the model can judge this and every later one instead. */}
      {approval.recommendation?.reason ? <div className="cdx-row"><span /><ModelJudgesToggle /></div> : null}
      {approval.dependencyNote ? <p className={`cdx-reason ao-dependency-note is-${approval.dependencyNote.tone}`}
        role={approval.dependencyNote.tone === "warn" ? "alert" : "note"}>{approval.dependencyNote.text}</p> : null}
      <CdxOptions name={title} options={options} picked={sent ? [sent] : []} onPick={send} disabled={busy || Boolean(sent)} />
    </div>
  </div>;
}

export type ApprovalReply = boolean | { decisionId: string } | Record<string, unknown>;
/** How long ago an AO request started waiting (AO ends an unanswered one after 30 minutes). */
function waited(since?: string) {
  const at = Date.parse(since ?? "");
  if (!Number.isFinite(at)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};


export function AgentOrchestratorApproval({ approval, busy, approve, actor = "the agent" }: {
  approval: AoApproval; busy: boolean; approve: (approval: AoApproval, reply: ApprovalReply) => void;
  /** Who asks, as Codex names "ChatGPT" in "Allow ChatGPT to run this command?": the card's model. */
  actor?: string;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [content, setContent] = useState("{}");
  const [error, setError] = useState("");
  const [scope, setScope] = useState("turn");
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const request = approval.request ?? {};
  const command = approval.command || (typeof request.command === "string" ? request.command : "");
  const kind = approval.kind;
  // Where it applies: a path or working folder. An AO request has neither for most tools, and its
  // card id is not a place, so nothing is shown then.
  const fallback = approval.source === "ao" ? "" : approval.nodeId;
  const location = kind === "command" ? (typeof request.cwd === "string" ? request.cwd : approval.cwd) || approval.path || fallback : approval.path || approval.cwd || fallback;
  const typed = Boolean(approval.method);
  const scoped = Boolean(approval.thread_id && approval.turn_id);
  const decisions: unknown[] = Array.isArray(request.availableDecisions) ? request.availableDecisions : ["accept", "acceptForSession", "decline", "cancel"];
  const questions = Array.isArray(request.questions) ? request.questions.map(object) : [];
  const permissions = object(request.permissions ?? approval.permissions);
  const permissionChoices = Object.entries(permissions).flatMap(([domain, value]) => {
    if (Array.isArray(value)) return value.map((entry, index) => ({ key: domain + ":" + index, domain, entry, index, group: "" }));
    if (value && typeof value === "object") return Object.entries(object(value)).flatMap(([group, entries]) =>
      Array.isArray(entries) ? entries.map((entry, index) => ({ key: domain + ":" + group + ":" + index, domain, group, entry, index })) :
        [{ key: domain + ":" + group, domain, group, entry: entries, index: -1 }]);
    return [{ key: domain, domain, group: "", entry: value, index: -1 }];
  });
  const replyPermissions = () => {
    const selected: Record<string, unknown> = {};
    for (const item of permissionChoices.filter(item => granted[item.key])) {
      if (item.group) {
        const group = object(selected[item.domain]);
        if (item.index >= 0) group[item.group] = [...(Array.isArray(group[item.group]) ? group[item.group] as unknown[] : []), item.entry];
        else group[item.group] = item.entry;
        selected[item.domain] = group;
      } else if (item.index >= 0) selected[item.domain] = [...(Array.isArray(selected[item.domain]) ? selected[item.domain] as unknown[] : []), item.entry];
      else selected[item.domain] = item.entry;
    }
    approve(approval, { permissions: selected, scope });
  };
  const sendForm = () => {
    try {
      const value: unknown = JSON.parse(content);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter a JSON object matching the requested schema.");
      setError(""); approve(approval, { action: "accept", content: value });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const supported = !typed || ["command", "file_change", "permissions", "questions", "mcp_form", "mcp_url"].includes(kind || "");
  const nativeCommand = kind === "command";
  if (approval.source === "ao" && approval.kind === "question") return <AoQuestion approval={approval} busy={busy} approve={approve} />;
  // Claude Code finished planning: show the plan and every way it offered to go on.
  if (approval.source === "ao" && approval.plan) {
    const when = waited(approval.since);
    return <div className="ao-msg ao-msg-approval ao-msg-plan">
      <span className="ao-msg-meta">Plan ready · {approval.tool || "ExitPlanMode"}{when ? ` · asked ${when}` : ""}</span>
      <div className="ao-plan"><ChatMarkdown text={approval.plan} /></div>
      <p className="ao-hint">The agent waits up to 30 minutes for your answer. Messages you send now arrive after it.</p>
      <fieldset disabled={busy}><div className="ao-msg-actions">
        {(approval.decisions ?? []).map((decision) => <button key={decision.id} type="button"
          className={decision.kind.startsWith("reject") ? "button-secondary" : "button-primary"}
          onClick={() => approve(approval, { decisionId: decision.id })}>{decision.label}</button>)}
      </div></fieldset>
    </div>;
  }
  // An AO agent's tool request: Codex's approval card.
  if (approval.source === "ao") return <AoAsk approval={approval} busy={busy} approve={approve} actor={actor} />;
  const nativeBody = <>
    <span className={nativeCommand ? "cdx-kind" : "ao-msg-meta"}>{nativeCommand ? "Terminal" : <>{typed ? "Native request" : "Approval needed"} · {kind || "Tool request"}{approval.tool ? " · " + approval.tool : ""}</>}</span>
    {nativeCommand ? <span className="cdx-title">Allow {actor} to run this command?</span> : null}
    <p className={nativeCommand ? "cdx-reason" : undefined}>{approval.reason || approval.summary || String(request.message || "Tool request")}{location ? ` · ${location}` : ""}</p>
    {typed ? <p className="ao-hint">{approval.method} · Thread {approval.thread_id || "unknown"} · Turn {approval.turn_id || "unknown"}{approval.item_id ? " · Item " + approval.item_id : ""}</p> : null}
    {command ? <ApprovalCode text={command} label="Command" /> : approval.toolInput ? <ApprovalCode text={approval.toolInput} label="Tool input" /> : null}
    {approval.dependencyNote ? <p className={`ao-hint ao-dependency-note is-${approval.dependencyNote.tone}`}
      role={approval.dependencyNote.tone === "warn" ? "alert" : "note"}>{approval.dependencyNote.text}</p> : null}
    {approval.recommendation ? <p className="ao-hint">Command approver suggests {approval.recommendation.action}: {approval.recommendation.reason}</p> : null}
    {typed ? <details><summary>Raw request</summary>{nativeCommand ? <ApprovalCode text={JSON.stringify(request, null, 2)} label="Raw request" /> : <pre>{JSON.stringify(request, null, 2)}</pre>}</details> : null}
    {typed && !scoped ? <p role="alert">Can't answer: this request has no live turn. Refresh it or reconnect this agent.</p> : null}
    {!supported ? <p role="alert">This request type isn't supported. Update the bridge or stop this agent. Nothing was approved.</p> : null}
    <fieldset disabled={busy || (typed && !scoped) || !supported}>
      {!typed ? <div className={nativeCommand ? "cdx-options" : "ao-msg-actions"}>
        <button type="button" className={nativeCommand ? "cdx-option" : "button-primary"} onClick={() => approve(approval, true)}>
          {nativeCommand ? <><span className="cdx-option-mark" aria-hidden="true">1</span><span className="cdx-option-label">Allow once</span></> : "Allow once"}</button>
        <button type="button" className={nativeCommand ? "cdx-option" : "button-secondary"} onClick={() => approve(approval, false)}>
          {nativeCommand ? <><span className="cdx-option-mark" aria-hidden="true">2</span><span className="cdx-option-label">Deny</span></> : "Deny"}</button>
      </div> : null}
      {typed && (kind === "command" || kind === "file_change") ? <div className={nativeCommand ? "cdx-options" : "ao-msg-actions"}>{decisions.map((decision, index) => {
        const label = typeof decision === "string" ? (nativeCommand ? NATIVE_DECISION_WORDS[decision] ?? decision : decision) : JSON.stringify(decision);
        return <button key={index} type="button" className={nativeCommand ? "cdx-option" : "button-secondary"} onClick={() => approve(approval, { decision })}>
          {nativeCommand ? <><span className="cdx-option-mark" aria-hidden="true">{index + 1}</span><span className="cdx-option-label">{label}</span></> : label}</button>;
      })}</div> : null}
      {typed && kind === "permissions" ? <>
        <p>Pick the permissions to allow. None are picked yet.</p>
        {permissionChoices.map(item => <label key={item.key}><input type="checkbox" checked={Boolean(granted[item.key])} onChange={event => setGranted(current => ({ ...current, [item.key]: event.target.checked }))} />{item.domain}{item.group ? " / " + item.group : ""}: {JSON.stringify(item.entry)}</label>)}
        <label>Allow for<select value={scope} onChange={event => setScope(event.target.value)}><option value="turn">This turn</option><option value="session">This session</option></select></label>
        <button type="button" className="button-primary" onClick={replyPermissions}>Allow selected</button>
        <button type="button" className="button-secondary" onClick={() => approve(approval, { permissions: {}, scope: "turn" })}>Deny all</button>
      </> : null}
      {typed && kind === "questions" ? <>
        {questions.map(question => <label key={String(question.id)}>{String(question.header || question.id)} · {String(question.question || "")}
          <input type={question.isSecret === true ? "password" : "text"} autoComplete={question.isSecret === true ? "off" : undefined} value={answers[String(question.id)] || ""} onChange={event => setAnswers(current => ({ ...current, [String(question.id)]: event.target.value }))} list={"ao-question-" + String(question.id)} />
          <datalist id={"ao-question-" + String(question.id)}>{(Array.isArray(question.options) ? question.options.map(object) : []).map(option => <option key={String(option.label)} value={String(option.label)}>{String(option.description || "")}</option>)}</datalist>
        </label>)}
        <button type="button" className="button-primary" onClick={() => approve(approval, { answers: Object.fromEntries(questions.map(question => [String(question.id), { answers: answers[String(question.id)] ? [answers[String(question.id)]] : [] }])) })}>Send answers</button>
        <button type="button" className="button-secondary" onClick={() => approve(approval, { answers: {} })}>Cancel questions</button>
      </> : null}
      {typed && (kind === "mcp_form" || kind === "mcp_url") ? <>
        <p>This consent applies to this request only, not to the project's MCP access.</p>
        {kind === "mcp_form" ? <><pre aria-label="Requested form schema">{JSON.stringify(request.requestedSchema ?? request.schema ?? {}, null, 2)}</pre>
          <label>Form values (JSON)<textarea aria-label="MCP form values" rows={5} value={content} onChange={event => setContent(event.target.value)} /></label>
          <button type="button" className="button-primary" onClick={sendForm}>Submit form</button></> : <>
          {typeof request.url === "string" && /^https?:\/\//i.test(request.url) ? <a href={request.url} target="_blank" rel="noreferrer">Open authorization page</a> : <p>No valid authorization link.</p>}
          <button type="button" className="button-primary" onClick={() => approve(approval, { action: "accept" })}>Authorization completed</button>
        </>}
        <button type="button" className="button-secondary" onClick={() => approve(approval, { action: "decline" })}>Decline</button>
        <button type="button" className="button-secondary" onClick={() => approve(approval, { action: "cancel" })}>Cancel</button>
      </> : null}
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
  </>;
  return nativeCommand ? <div className="cdx-card"><div className="cdx-body">{nativeBody}</div></div>
    : <div className="ao-msg ao-msg-approval">{nativeBody}</div>;
}
