import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { Icon } from "../icons";
import { useComposerPopover } from "./AgentOrchestratorComposerControls";

type Branch = { name: string; updatedAt: string | null; upstream: string | null; worktree: string | null; current: boolean; chat: boolean; default?: boolean };
export type ChatBranches = { git: boolean; root?: string; current?: string | null; chatBranch?: string | null; defaultBranch?: string | null; branches: Branch[]; truncated?: boolean };

type ModuleReply = { ok?: boolean; result?: unknown };

const REFRESH_MS = 15_000;

function ago(iso: string | null) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** The folder name of a worktree path, for the "in worktree …" note. */
const folderName = (worktree: string) => worktree.split(/[\\/]/).filter(Boolean).at(-1) ?? worktree;

const resultOf = (reply: ModuleReply) => {
  const result = (reply.result && typeof reply.result === "object" ? reply.result : null) as ({ ok?: boolean; error?: string } & Partial<ChatBranches>) | null;
  return reply.ok === false || !result || result.ok === false ? null : result;
};
/** A refused operation's reason, where moduleCall() reads it too. */
const failureOf = (reply: ModuleReply) => {
  const result = (reply.result && typeof reply.result === "object" ? reply.result : {}) as { reason?: unknown; detail?: unknown };
  return String(result.reason || result.detail || "The branch could not be switched");
};

/**
 * The bar above the chat box: the branch this chat works on (its own worktree's for a chat AO gave
 * one, otherwise the project folder's) and a menu of every branch in the project: the default
 * branch first, then the user's own, then AO's ao/* ones. Choosing one checks it out in the
 * project folder, where chats work; a branch another worktree has checked out cannot be chosen.
 */
export function ChatBranchBar({ workspaceId, sessionId, inline = false }: { workspaceId?: string; sessionId?: string; inline?: boolean }) {
  const [data, setData] = useState<ChatBranches | null>(null);
  const [search, setSearch] = useState("");
  const [switching, setSwitching] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const popup = useComposerPopover();
  useEffect(() => {
    if (!workspaceId) { setData(null); return; }
    let live = true;
    const read = () => void getCodingToolsClient().apps.call({
      moduleId: "agent-orchestrator", operation: "chat_branches", arguments: { workspaceId, ...(sessionId ? { sessionId } : {}) },
    }).then((reply) => {
      const result = resultOf(reply as ModuleReply);
      if (live) setData(result && Array.isArray(result.branches) ? result as ChatBranches : null);
    }).catch(() => { if (live) setData(null); });
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [workspaceId, sessionId, revision]);
  useEffect(() => { if (!popup.open) setFailure(null); }, [popup.open]);
  if (!data) return null;
  // Inline, it is one chip in the new-chat strip; otherwise a bar over the composer of a chat.
  const barClass = inline ? "cx-branch-bar is-inline" : "cx-branch-bar";
  if (!data.git) {
    return <div className={barClass}><span className="cx-branch-note" title="Agent harnesses need a git repository; Native Codex works here">
      <Icon name="git" width="14" height="14" />Not a git repository</span></div>;
  }
  const choose = (branch: Branch) => {
    if (!workspaceId || switching) return;
    if (branch.current) { popup.setOpen(false); return; }
    setSwitching(branch.name);
    setFailure(null);
    void getCodingToolsClient().apps.call({
      moduleId: "agent-orchestrator", operation: "chat_switch_branch", arguments: { workspaceId, branch: branch.name },
    }).then((reply) => {
      const result = resultOf(reply as ModuleReply);
      if (!result) { setFailure(failureOf(reply as ModuleReply)); return; }
      popup.setOpen(false);
      setRevision((value) => value + 1);
    }).catch((error: unknown) => setFailure(error instanceof Error ? error.message : String(error)))
      .finally(() => setSwitching(null));
  };
  const inUse = data.chatBranch || data.current || "";
  const query = search.trim().toLowerCase();
  const shown = data.branches.filter((branch) => !query || branch.name.toLowerCase().includes(query));
  return <div className={barClass}>
    <div className="ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
      <button type="button" className="cx-branch-chip" ref={popup.trigger} aria-haspopup="dialog" aria-expanded={popup.open}
        aria-label={`Branch: ${inUse}`} title={data.chatBranch && data.chatBranch !== data.current
          ? `This chat works on ${data.chatBranch}; the project folder is on ${data.current}` : `On ${inUse}`}
        onClick={() => popup.setOpen((value) => !value)}>
        <Icon name="git" width="14" height="14" /><span>{inUse}</span><span aria-hidden="true">⌄</span>
      </button>
      {popup.open ? <section ref={popup.panel} role="dialog" aria-label="Branches" className="ao-composer-popover cx-branch-popup">
        <input className="ao-model-search" type="search" aria-label="Search branches" placeholder="Search branches…" value={search}
          onChange={(event) => setSearch(event.target.value)} />
        {failure ? <p className="cx-branch-error" role="alert">{failure}</p> : null}
        <ul className="cx-branch-list" aria-label="Branches">
          {shown.map((branch) => {
            // Another worktree has it checked out: git cannot check it out in the folder too.
            const held = Boolean(branch.worktree) && !branch.current;
            return <li key={branch.name} className={branch.current ? "is-in-use" : undefined}>
              <button type="button" className="cx-branch-option" disabled={held || Boolean(switching)}
                aria-current={branch.current ? "true" : undefined} onClick={() => choose(branch)}
                title={[branch.name, branch.upstream ? `tracks ${branch.upstream}` : "",
                  held ? `checked out in ${branch.worktree}; finish or remove that chat to use it here` : "",
                  !held && !branch.current ? "Check out in the project folder" : ""].filter(Boolean).join("\n")}>
                <span className="cx-branch-name">{branch.name}</span>
                <span className="cx-branch-tags">
                  {branch.default ? <em>default</em> : null}
                  {branch.chat ? <em>this chat</em> : null}
                  {branch.current ? <em>project folder</em> : null}
                  {held && !branch.chat ? <small>in {folderName(branch.worktree!)}</small> : null}
                  {switching === branch.name ? <small>switching…</small> : <small>{ago(branch.updatedAt)}</small>}
                </span>
                {branch.current ? <Icon name="check" width="14" height="14" /> : null}
              </button>
            </li>;
          })}
          {!shown.length ? <li className="cx-branch-empty" role="status">No matching branches</li> : null}
        </ul>
        {data.truncated ? <p className="ao-popup-muted">Showing the {data.branches.length} newest branches.</p> : null}
      </section> : null}
    </div>
    {data.chatBranch && data.current && data.chatBranch !== data.current
      ? <span className="cx-branch-note" title="The project folder's own branch">folder on {data.current}</span> : null}
  </div>;
}
