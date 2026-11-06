import { useState } from "react";
import type { ChangedFile } from "./ChatReplyHead";

// Codex desktop's completed turn diff: a resource card, three 36px file rows, then Show more.
// Reference: OpenAI.Codex 26.1016.6573.0, sites-end-resource jD/ID/RD and resource-card _ii/xii.
const FILES_SHOWN = 3;

function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="cx-turn-change-counts"><span className="is-add">+{added.toLocaleString()}</span><span className="is-del">-{removed.toLocaleString()}</span></span>;
}

export function ChatTurnChanges({ files, onOpen }: { files: ChangedFile[]; onOpen?: (path?: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!files.length) return null;
  const single = files.length === 1;
  const totals = files.reduce((sum, file) => ({ added: sum.added + file.additions, removed: sum.removed + file.deletions }), { added: 0, removed: 0 });
  const shown = expanded ? files : files.slice(0, FILES_SHOWN);
  const name = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;
  return <section className="cx-turn-changes" aria-label="Changed files">
    <div className="cx-turn-changes-head">
      <button type="button" className="cx-turn-changes-open" aria-label="View changed files" disabled={!onOpen} onClick={() => onOpen?.(single ? files[0].path : undefined)} />
      <span className="cx-turn-changes-icon" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect x="3.75" y="3.75" width="16.5" height="16.5" rx="3" stroke="currentColor" strokeWidth="1.5" />
        <path d="m9.5 9-3 3 3 3m5-6 3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg></span>
      <span className="cx-turn-changes-heading"><span className="cx-turn-changes-title">{single ? `Edited ${name(files[0].path)}` : `Edited ${files.length} files`}</span>
        <span className="cx-turn-changes-totals"><Counts added={totals.added} removed={totals.removed} /></span>
        <span className="cx-turn-changes-hover">View changes <span aria-hidden="true">→</span></span>
      </span>
      <button type="button" className="cx-turn-changes-view" disabled={!onOpen} onClick={() => onOpen?.(single ? files[0].path : undefined)}>View changes</button>
    </div>
    {!single ? <div className="cx-turn-changes-files">{shown.map((file) => {
      const normalized = file.path.replace(/\\/g, "/");
      const slash = normalized.lastIndexOf("/");
      return <button type="button" className="cx-turn-change-file" key={file.path} title={file.path} disabled={!onOpen} onClick={() => onOpen?.(file.path)}>
        <span className="cx-sr-only">{file.path}</span>
        <span className="cx-turn-change-path" aria-hidden="true">{slash >= 0 ? <span className="cx-turn-change-dir">{normalized.slice(0, slash + 1)}</span> : null}<span className="cx-turn-change-name">{normalized.slice(slash + 1)}</span></span>
        <Counts added={file.additions} removed={file.deletions} />
      </button>;
    })}{files.length > FILES_SHOWN ? <button type="button" className="cx-turn-changes-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span>{expanded ? "Collapse files" : `Show ${files.length - FILES_SHOWN} more ${files.length - FILES_SHOWN === 1 ? "file" : "files"}`}</span>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button> : null}</div> : null}
  </section>;
}
