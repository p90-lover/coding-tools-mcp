import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { ChatGlyph } from "./ChatMenu";

/** The project being edited: its name, primary folder and extra source folders. */
export type EditableProject = {
  id: string;
  name: string;
  path: string;
  linkedProjects?: readonly { readonly path: string }[];
};

export type ProjectEditSave = { name: string; path: string; linkedPaths: string[] };

/** Where a project's chats work (AO's workspace mode). */
export type WorkspaceMode = "worktree" | "shared" | "folder";
export type WorkspaceModeState = { available: boolean; mode?: WorkspaceMode; reason?: string };

export const WORKSPACE_MODE_OPTIONS: readonly { value: WorkspaceMode; label: string; hint: string }[] = [
  { value: "folder", label: "The project folder itself (default)",
    hint: "Chats edit this folder directly, with your uncommitted work, on the branch chosen above the chat box. No branch or copy is made. Chats running at the same time can change the same files." },
  { value: "worktree", label: "A new worktree for each chat",
    hint: "Each chat works on its own new branch in its own copy, so chats never touch each other's files or yours." },
  { value: "shared", label: "One shared worktree",
    hint: "Every chat in this project works in the same copy, set up once and kept. Chats running at the same time can change the same files." },
];

/** A folder's last path segment: "coding-tools-mcp" for G:\Projects\coding-tools-mcp. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || path;
}

/** Windows paths (a drive letter or a UNC share) compare without case, as the file system does. */
export function sameFolder(left: string, right: string): boolean {
  const clean = (value: string) => value.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(clean(left));
  return windows ? clean(left).toLowerCase() === clean(right).toLowerCase() : clean(left) === clean(right);
}

/** Removes the folder at `index`; the first remaining folder is the project's primary folder. */
export function removeFolder(folders: readonly string[], index: number): string[] {
  return folders.length <= 1 ? [...folders] : folders.filter((_, at) => at !== index);
}

/** The first folder is the primary one; the rest are linked as extra source folders. */
export function projectFolders(project: EditableProject): string[] {
  const folders = [project.path];
  for (const linked of project.linkedProjects ?? []) {
    if (!folders.some((folder) => sameFolder(folder, linked.path))) folders.push(linked.path);
  }
  return folders;
}

/**
 * Codex's "Edit project" dialog: the project's name, its source folders (the first is the
 * project's own folder) and "Remove local project", which only drops it from this app's list.
 */
export function ProjectEditDialog({ project, initialStep = "edit", chooseFolder, onSave, onRemove, onClose, readWorkspaceMode, saveWorkspaceMode }: {
  project: EditableProject;
  /** "remove" opens straight at the remove confirmation (the sidebar's "Remove project"). */
  initialStep?: "edit" | "remove";
  /** The system folder picker; resolves null when cancelled. */
  chooseFolder?: () => Promise<string | null>;
  onSave: (change: ProjectEditSave) => Promise<void>;
  onRemove?: () => Promise<void>;
  onClose: () => void;
  /** Reads where this project's chats work; absent hides the choice. */
  readWorkspaceMode?: () => Promise<WorkspaceModeState>;
  /** Saves where this project's chats work. */
  saveWorkspaceMode?: (mode: WorkspaceMode) => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  const [folders, setFolders] = useState<string[]>(() => projectFolders(project));
  const [step, setStep] = useState<"edit" | "remove">(initialStep);
  const [busy, setBusy] = useState<"" | "pick" | "save" | "remove">("");
  const [error, setError] = useState("");
  // Where chats work: read once when the dialog opens; null while loading or unavailable.
  const [modeState, setModeState] = useState<WorkspaceModeState | null>(null);
  const [mode, setMode] = useState<WorkspaceMode | null>(null);
  useEffect(() => {
    if (!readWorkspaceMode) return undefined;
    let live = true;
    readWorkspaceMode()
      .then((state) => { if (live) { setModeState(state); setMode(state.mode ?? null); } })
      .catch((cause) => { if (live) setModeState({ available: false, reason: cause instanceof Error ? cause.message : String(cause) }); });
    return () => { live = false; };
    // Once per project: the reader is usually an inline arrow, new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const cancel = () => { if (busy !== "save" && busy !== "remove") onClose(); };
  const back = () => { setError(""); if (initialStep === "remove") cancel(); else setStep("edit"); };
  // Escape cancels even while focus is outside the dialog (its first render, a closed picker).
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); if (step === "remove") back(); else cancel(); } };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  });
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (step === "remove") back(); else cancel();
  };
  const onBackdrop = (event: ReactMouseEvent) => { if (event.target === event.currentTarget) cancel(); };

  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const addFolder = async () => {
    if (!chooseFolder || busy) return;
    setBusy("pick"); setError("");
    try {
      const folder = await chooseFolder();
      if (!folder) return;
      if (folders.some((item) => sameFolder(item, folder))) { setError(`${folderName(folder)} is already listed`); return; }
      setFolders((current) => [...current, folder]);
    } catch (cause) { fail(cause); }
    finally { setBusy(""); }
  };
  const trimmed = name.trim();
  const original = projectFolders(project);
  const projectChanged = trimmed !== project.name || folders.length !== original.length || folders.some((folder, index) => folder !== original[index]);
  const modeChanged = Boolean(mode && modeState?.mode && mode !== modeState.mode);
  const changed = projectChanged || modeChanged;
  const canSave = Boolean(trimmed) && trimmed.length <= 128 && folders.length > 0 && !busy;
  const save = async () => {
    if (!canSave) return;
    if (!changed) { onClose(); return; }
    setBusy("save"); setError("");
    try {
      // The mode first: it belongs to the AO project behind the current folder, which a changed
      // primary folder would no longer reach.
      if (modeChanged && mode && saveWorkspaceMode) await saveWorkspaceMode(mode);
      if (projectChanged) await onSave({ name: trimmed, path: folders[0], linkedPaths: folders.slice(1) });
      onClose();
    } catch (cause) { fail(cause); setBusy(""); }
  };
  const modeHint = WORKSPACE_MODE_OPTIONS.find((option) => option.value === mode)?.hint;
  const remove = async () => {
    if (!onRemove || busy) return;
    setBusy("remove"); setError("");
    try {
      await onRemove();
      onClose();
    } catch (cause) { fail(cause); setBusy(""); }
  };

  return (
    <div className="cx-modal-backdrop" onMouseDown={onBackdrop}>
      <div className="cx-modal cx-project-edit" role="dialog" aria-modal="true" aria-labelledby="cx-project-edit-title" onKeyDown={onKeyDown}>
        <header className="cx-modal-head">
          <h2 id="cx-project-edit-title">{step === "remove" ? "Remove local project?" : "Edit project"}</h2>
          <button type="button" className="cx-modal-close" aria-label="Close" title="Close" onClick={cancel}>×</button>
        </header>
        {step === "remove" ? <>
          <div className="cx-modal-body">
            <p className="cx-modal-text"><strong>{project.name}</strong> will be removed from Coding Tools.</p>
            <p className="cx-modal-hint">Its folders and files stay on disk and are not deleted. Its chats are kept. Add the folder again with New project to bring it back.</p>
            {error ? <p className="cx-modal-error" role="alert">{error}</p> : null}
          </div>
          <footer className="cx-modal-foot">
            <span className="cx-modal-spacer" />
            <button type="button" className="cx-modal-button" onClick={back} disabled={busy === "remove"}>Cancel</button>
            <button type="button" className="cx-modal-button is-danger" onClick={() => void remove()} disabled={!onRemove || Boolean(busy)}>
              {busy === "remove" ? "Removing…" : "Remove"}</button>
          </footer>
        </> : <>
          <div className="cx-modal-body">
            <label className="cx-field">
              <span className="cx-field-label">Name</span>
              <span className="cx-field-input">
                <ChatGlyph name="folder" size={14} />
                <input value={name} maxLength={128} aria-label="Project name" autoFocus spellCheck={false}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} />
              </span>
            </label>
            <div className="cx-field">
              <span className="cx-field-label" id="cx-project-folders">Source folders</span>
              <ul className="cx-folder-list" aria-labelledby="cx-project-folders">
                {folders.map((folder, index) => (
                  <li key={folder} className="cx-folder-row" title={folder}>
                    <ChatGlyph name="folder" size={14} />
                    <span className="cx-folder-text">
                      <span className="cx-folder-name">{folderName(folder)}</span>
                      <span className="cx-folder-path">{folder}</span>
                    </span>
                    <button type="button" className="cx-folder-remove" aria-label={`Remove ${folderName(folder)}`}
                      title={folders.length <= 1 ? "A project needs at least one folder" : "Remove folder"}
                      disabled={folders.length <= 1 || Boolean(busy)} onClick={() => setFolders((current) => removeFolder(current, index))}>×</button>
                  </li>
                ))}
                <li>
                  <button type="button" className="cx-folder-add" onClick={() => void addFolder()} disabled={!chooseFolder || Boolean(busy)}>
                    <ChatGlyph name="plus" size={14} />Add folder</button>
                </li>
              </ul>
            </div>
            {readWorkspaceMode ? <label className="cx-field">
              <span className="cx-field-label">Chats work in</span>
              {modeState?.available && mode ? <>
                <select className="cx-field-select" value={mode} disabled={Boolean(busy)} aria-label="Where this project's chats work"
                  onChange={(event) => setMode(event.target.value as WorkspaceMode)}>
                  {WORKSPACE_MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                {modeHint ? <span className={`cx-modal-hint${mode === "folder" ? " is-warning" : ""}`}>{modeHint} Applies to chats started after saving.</span> : null}
              </> : <span className="cx-modal-hint">{modeState ? modeState.reason || "Not available for this project." : "Loading…"}</span>}
            </label> : null}
            {error ? <p className="cx-modal-error" role="alert">{error}</p> : null}
          </div>
          <footer className="cx-modal-foot">
            <button type="button" className="cx-modal-button is-danger-soft" onClick={() => { setError(""); setStep("remove"); }}
              disabled={!onRemove || Boolean(busy)} title="Remove from Coding Tools. No files are deleted.">Remove local project</button>
            <span className="cx-modal-spacer" />
            <button type="button" className="cx-modal-button" onClick={cancel} disabled={busy === "save"}>Cancel</button>
            <button type="button" className="cx-modal-button is-primary" onClick={() => void save()} disabled={!canSave}>
              {busy === "save" ? "Saving…" : "Save"}</button>
          </footer>
        </>}
      </div>
    </div>
  );
}
