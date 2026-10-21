import { useEffect, useState, type CSSProperties } from "react";
import { getCodingToolsClient } from "../api/client";
import { Caret, Icon } from "../icons";
import { useComposerPopover } from "./AgentOrchestratorComposerControls";
import { useSurfaceHidden } from "./page-visibility";

type Branch = {
  name: string; updatedAt: string | null; upstream: string | null; worktree: string | null; current: boolean; chat: boolean; default?: boolean;
  /** Tip commit, its subject, and how far it is from the default branch. */
  commit?: string | null; subject?: string | null; ahead?: number; behind?: number;
  /** Against its upstream, as git says it: "ahead 1, behind 2", "gone", or absent when in step. */
  track?: string;
};
type Changes = { staged: number; modified: number; untracked: number };
export type ChatBranches = {
  git: boolean; root?: string; current?: string | null; chatBranch?: string | null; defaultBranch?: string | null; branches: Branch[]; truncated?: boolean;
  /** Uncommitted work in the project folder, and in this chat's own worktree when it has one. */
  folderChanges?: Changes; chatChanges?: Changes;
};

type ModuleReply = { ok?: boolean; result?: unknown };

const REFRESH_MS = 15_000;

/** How long ago the branch's tip was committed: "5m", "3h", "4d", "8w", "5mo". */
function ago(iso: string | null) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 14 ? `${days}d` : days < 60 ? `${Math.round(days / 7)}w` : `${Math.round(days / 30)}mo`;
}

/** "83 modified · 57 untracked", or "No uncommitted changes". */
export function changesText(changes?: Changes) {
  if (!changes) return "";
  const parts = [changes.staged ? `${changes.staged} staged` : "", changes.modified ? `${changes.modified} modified` : "",
    changes.untracked ? `${changes.untracked} untracked` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No uncommitted changes";
}

/** A branch against the default one: "↑2 ↓1", "same as main", or nothing for the default itself. */
export function divergence(branch: Branch, defaultBranch?: string | null) {
  if (branch.default || !defaultBranch || branch.ahead === undefined || branch.behind === undefined) return "";
  if (!branch.ahead && !branch.behind) return `same as ${defaultBranch}`;
  return [branch.ahead ? `↑${branch.ahead}` : "", branch.behind ? `↓${branch.behind}` : ""].filter(Boolean).join(" ");
}

const GROUPS = [
  { key: "default", label: "Default" },
  { key: "own", label: "Your branches" },
  { key: "agent", label: "Agent branches" },
] as const;
const groupOf = (branch: Branch) => (branch.default ? "default" : branch.name.startsWith("ao/") ? "agent" : "own");

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
  const surfaceHidden = useSurfaceHidden();
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
    // Each read runs about a dozen git commands in the main process. A minimized window or a hidden
    // tab skips its refreshes, and the list is read again when the menu opens (below).
    const timer = window.setInterval(() => { if (!surfaceHidden()) read(); }, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [workspaceId, sessionId, revision, surfaceHidden]);
  // Opening the menu shows the branches as they are now, not as of the last refresh.
  useEffect(() => { if (popup.open) setRevision((value) => value + 1); }, [popup.open]);
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
  const shown = data.branches.filter((branch) => !query || branch.name.toLowerCase().includes(query)
    || (branch.subject ?? "").toLowerCase().includes(query));
  // This chat's own worktree when AO gave it one, else the project folder it works in.
  const ownWorktree = Boolean(data.chatBranch && data.chatBranch !== data.current);
  const workChanges = ownWorktree ? data.chatChanges : data.folderChanges;
  const inUseBranch = data.branches.find((branch) => branch.name === inUse);
  let row = 0;
  return <div className={barClass}>
    <div className="ao-composer-picker" ref={popup.root} onKeyDown={popup.onKeyDown}>
      <button type="button" className="cx-branch-chip" ref={popup.trigger} aria-haspopup="dialog" aria-expanded={popup.open}
        aria-label={`Branch: ${inUse}`} title={data.chatBranch && data.chatBranch !== data.current
          ? `This chat works on ${data.chatBranch}; the project folder is on ${data.current}` : `On ${inUse}`}
        onClick={() => popup.setOpen((value) => !value)}>
        <Icon name="git" width="14" height="14" /><span>{inUse}</span><Caret />
      </button>
      {popup.open ? <section ref={popup.panel} role="dialog" aria-label="Branches" className="ao-composer-popover cx-branch-popup">
        <header className="cx-branch-head">
          <div className="cx-branch-head-title">
            <Icon name="git" width="15" height="15" /><strong>{inUse}</strong>
            {inUseBranch?.track ? <span className="cx-branch-pill" title={`Against ${inUseBranch.upstream}`}>{inUseBranch.track}</span> : null}
          </div>
          <p className="cx-branch-head-line">
            <span>{ownWorktree ? "This chat's worktree" : "Project folder"}</span>
            {workChanges ? <span className={workChanges.staged + workChanges.modified + workChanges.untracked ? "is-dirty" : "is-clean"}>{changesText(workChanges)}</span> : null}
          </p>
          {inUseBranch?.commit ? <p className="cx-branch-head-commit" title={inUseBranch.subject ?? undefined}>
            <code>{inUseBranch.commit}</code><span>{inUseBranch.subject}</span><small>{ago(inUseBranch.updatedAt)}</small></p> : null}
          {ownWorktree ? <p className="cx-branch-head-line is-secondary">
            <span>Project folder on {data.current}</span>{data.folderChanges ? <span>{changesText(data.folderChanges)}</span> : null}</p> : null}
        </header>
        <input className="ao-model-search cx-branch-search" type="search" aria-label="Search branches" placeholder="Search branches or commits…" value={search}
          onChange={(event) => setSearch(event.target.value)} />
        {failure ? <p className="cx-branch-error" role="alert">{failure}</p> : null}
        <div className="cx-branch-scroll">
          {GROUPS.map((group) => {
            const members = shown.filter((branch) => groupOf(branch) === group.key);
            if (!members.length) return null;
            return <section key={group.key} className="cx-branch-group" aria-label={group.label}>
              <h4>{group.label}<span>{members.length}</span></h4>
              <ul className="cx-branch-list">
                {members.map((branch) => {
                  // Another worktree has it checked out: git cannot check it out in the folder too.
                  const held = Boolean(branch.worktree) && !branch.current;
                  const versus = divergence(branch, data.defaultBranch);
                  const index = row++;
                  return <li key={branch.name} className={branch.current ? "is-in-use" : undefined}
                    style={{ "--row": Math.min(index, 14) } as CSSProperties}>
                    <button type="button" className="cx-branch-option" disabled={held || Boolean(switching)}
                      aria-current={branch.current ? "true" : undefined} onClick={() => choose(branch)}
                      title={[branch.name, branch.commit ? `${branch.commit} ${branch.subject ?? ""}` : "",
                        branch.updatedAt ? `last commit ${new Date(branch.updatedAt).toLocaleString()}` : "",
                        branch.upstream ? `tracks ${branch.upstream}${branch.track ? ` (${branch.track})` : ""}` : "",
                        held ? `checked out in ${branch.worktree}; finish or remove that chat to use it here` : "",
                        !held && !branch.current ? "Check out in the project folder" : ""].filter(Boolean).join("\n")}>
                      <span className="cx-branch-main">
                        <span className="cx-branch-name">{branch.name}</span>
                        <span className="cx-branch-sub">
                          {branch.commit ? <code>{branch.commit}</code> : null}<span>{branch.subject || "No commits"}</span>
                        </span>
                      </span>
                      <span className="cx-branch-tags">
                        {branch.default ? <em>default</em> : null}
                        {branch.chat ? <em>this chat</em> : null}
                        {branch.current ? <em>project folder</em> : null}
                        {held && !branch.chat ? <small className="cx-branch-pill">in {folderName(branch.worktree!)}</small> : null}
                        {group.key === "agent" && !branch.worktree ? <small className="cx-branch-pill is-faint" title="Its chat's worktree was removed">no worktree</small> : null}
                        {versus ? <small className={`cx-branch-versus${versus.startsWith("same") ? " is-even" : ""}`}>{versus}</small> : null}
                        {switching === branch.name ? <small>switching…</small> : <small className="cx-branch-age" title="Last commit">{ago(branch.updatedAt)}</small>}
                      </span>
                      {branch.current ? <Icon name="check" width="14" height="14" /> : null}
                    </button>
                  </li>;
                })}
              </ul>
            </section>;
          })}
          {!shown.length ? <p className="cx-branch-empty" role="status">No matching branches</p> : null}
        </div>
        {data.truncated ? <p className="ao-popup-muted">Showing the {data.branches.length} newest branches.</p> : null}
      </section> : null}
    </div>
    {data.chatBranch && data.current && data.chatBranch !== data.current
      ? <span className="cx-branch-note" title="The project folder's own branch">folder on {data.current}</span> : null}
  </div>;
}
