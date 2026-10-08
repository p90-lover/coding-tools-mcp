import { useState } from "react";

export type AoApproval = {
  nodeId: string; approval_id: string; kind?: string; method?: string; path?: string; reason?: string; command?: string; cwd?: string;
  thread_id?: string; turn_id?: string; item_id?: string; request?: Record<string, unknown>;
  permissions?: Record<string, unknown>; seconds_remaining?: number;
  recommendation?: { action: "allow" | "deny" | "ask"; reason: string };
};
export type ApprovalReply = boolean | Record<string, unknown>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};


export function AgentOrchestratorApproval({ approval, busy, approve }: {
  approval: AoApproval; busy: boolean; approve: (approval: AoApproval, reply: ApprovalReply) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [content, setContent] = useState("{}");
  const [error, setError] = useState("");
  const [scope, setScope] = useState("turn");
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const request = approval.request ?? {};
  const kind = approval.kind;
  const location = kind === "command" ? (typeof request.cwd === "string" ? request.cwd : approval.cwd) || approval.path || approval.nodeId : approval.path || approval.cwd || approval.nodeId;
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
  return <div className="ao-msg ao-msg-approval">
    <span className="ao-msg-meta">{typed ? "Native request" : "Approval needed"} · {kind || "Tool request"}</span>
    <p>{approval.reason || String(request.message || "Tool request")} · {location}</p>
    {typed ? <p className="ao-hint">{approval.method} · Thread {approval.thread_id || "unknown"} · Turn {approval.turn_id || "unknown"}{approval.item_id ? " · Item " + approval.item_id : ""}</p> : null}
    {approval.command ? <pre>{approval.command}</pre> : null}
    {approval.recommendation ? <p className="ao-hint">Command approver suggests {approval.recommendation.action}: {approval.recommendation.reason}</p> : null}
    {typed ? <details><summary>Exact native request</summary><pre>{JSON.stringify(request, null, 2)}</pre></details> : null}
    {typed && !scoped ? <p role="alert">Missing live thread/turn scope. Refresh the request or reconnect this role through its normal consent flow; no response can be sent.</p> : null}
    {!supported ? <p role="alert">This runtime request is unsupported. Update the native bridge or stop the affected role; no automatic grant was sent.</p> : null}
    <fieldset disabled={busy || (typed && !scoped) || !supported}>
      {!typed ? <div className="ao-msg-actions"><button type="button" className="button-primary" onClick={() => approve(approval, true)}>Allow once</button><button type="button" className="button-secondary" onClick={() => approve(approval, false)}>Deny</button></div> : null}
      {typed && (kind === "command" || kind === "file_change") ? <div className="ao-msg-actions">{decisions.map((decision, index) =>
        <button key={index} type="button" className="button-secondary" onClick={() => approve(approval, { decision })}>{typeof decision === "string" ? decision : JSON.stringify(decision)}</button>)}</div> : null}
      {typed && kind === "permissions" ? <>
        <p>Select only requested permissions. None are selected by default.</p>
        {permissionChoices.map(item => <label key={item.key}><input type="checkbox" checked={Boolean(granted[item.key])} onChange={event => setGranted(current => ({ ...current, [item.key]: event.target.checked }))} />{item.domain}{item.group ? " / " + item.group : ""}: {JSON.stringify(item.entry)}</label>)}
        <label>Grant scope<select value={scope} onChange={event => setScope(event.target.value)}><option value="turn">This turn</option><option value="session">This session</option></select></label>
        <button type="button" className="button-primary" onClick={replyPermissions}>Send selected subset</button>
        <button type="button" className="button-secondary" onClick={() => approve(approval, { permissions: {}, scope: "turn" })}>Deny requested permissions</button>
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
        <p>MCP/app consent applies only to this native request, not workspace MCP rights.</p>
        {kind === "mcp_form" ? <><pre aria-label="Requested form schema">{JSON.stringify(request.requestedSchema ?? request.schema ?? {}, null, 2)}</pre>
          <label>Form values (JSON)<textarea aria-label="MCP form values" rows={5} value={content} onChange={event => setContent(event.target.value)} /></label>
          <button type="button" className="button-primary" onClick={sendForm}>Submit form</button></> : <>
          {typeof request.url === "string" && /^https?:\/\//i.test(request.url) ? <a href={request.url} target="_blank" rel="noreferrer">Open requested authorization URL</a> : <p>Authorization URL unavailable or unsupported.</p>}
          <button type="button" className="button-primary" onClick={() => approve(approval, { action: "accept" })}>Authorization completed</button>
        </>}
        <button type="button" className="button-secondary" onClick={() => approve(approval, { action: "decline" })}>Decline</button>
        <button type="button" className="button-secondary" onClick={() => approve(approval, { action: "cancel" })}>Cancel</button>
      </> : null}
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
  </div>;
}
