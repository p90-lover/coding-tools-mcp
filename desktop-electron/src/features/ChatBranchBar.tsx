import { useEffect, useState } from "react";
import { getCodingToolsClient } from "../api/client";
import { Icon } from "../icons";
import { useComposerPopover } from "./AgentOrchestratorComposerControls";

type Branch = { name: string; updatedAt: string | null; upstream: string | null; worktree: string | null; current: boolean; chat: boolean };
export type ChatBranches = { git: boolean; root?: string; current?: string | null; chatBranch?: string | null; branches: Branch[]; truncated?: boolean };

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

/**
 * The bar above the chat box: the branch this chat works on (its own worktree's once AO made it,
 * otherwise the project folder's) and a menu of every branch in the project, newest first, with
 * the worktree each is checked out in. Read-only: it shows what is in use, it changes nothing.
 */
export function ChatBranchBar({ workspaceId, sessionId }: { workspaceId?: string; sessionId?: string }) {
  const [data, setData] = useState<ChatBranches | null>(null);
  const [search, setSearch] = useState("");
  const popup = useComposerPopover();
  useEffect(() => {
    if (!workspaceId) { setData(null); return; }
    let live = true;
    const read = () => void getCodingToolsClient().apps.call({
      moduleId: "agent-orchestrator", operation: "chat_branches", arguments: { workspaceId, ...(sessionId ? { sessionId } : {}) },
    }).then((outer) => {
      const result = (outer.result && typeof outer.result === "object" ? outer.result : null) as (ChatBranches & { ok?: boolean }) | null;
      if (live) setData(outer.ok === false || !result || result.ok === false ? null : result);
    }).catch(() => { if (live) setData(null); });
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [workspaceId, sessionId]);
  if (!data) return null;
  if (!data.git) {
    return <div className="cx-branch-bar"><span className="cx-branch-note" title="Agent harnesses need a git repository; Native Codex works here">
      <Icon name="git" width="14" height="14" />Not a git repository</span></div>;
  }
  const inUse = data.chatBranch || data.current || "";
  const query = search.trim().toLowerCase();
  const shown = data.branches.filter((branch) => !query || branch.name.toLowerCase().includes(query));
  return <div className="cx-branch-bar">
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
        <ul className="cx-branch-list" aria-label="Branches">
          {shown.map((branch) => <li key={branch.name} className={branch.name === inUse ? "is-in-use" : undefined}
            title={[branch.name, branch.upstream ? `tracks ${branch.upstream}` : "", branch.worktree ? `checked out in ${branch.worktree}` : ""].filter(Boolean).join("\n")}>
            <span className="cx-branch-name">{branch.name}</span>
            <span className="cx-branch-tags">
              {branch.chat ? <em>this chat</em> : null}
              {branch.current ? <em>project folder</em> : null}
              {branch.worktree && !branch.current && !branch.chat ? <small>in {folderName(branch.worktree)}</small> : null}
              <small>{ago(branch.updatedAt)}</small>
            </span>
            {branch.name === inUse ? <Icon name="check" width="14" height="14" /> : null}
          </li>)}
          {!shown.length ? <li className="cx-branch-empty" role="status">No matching branches</li> : null}
        </ul>
        {data.truncated ? <p className="ao-popup-muted">Showing the {data.branches.length} newest branches.</p> : null}
      </section> : null}
    </div>
    {data.chatBranch && data.current && data.chatBranch !== data.current
      ? <span className="cx-branch-note" title="The project folder's own branch">folder on {data.current}</span> : null}
  </div>;
}
