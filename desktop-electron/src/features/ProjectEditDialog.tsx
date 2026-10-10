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
export function ProjectEditDialog({ project, initialStep = "edit", chooseFolder, onSave, onRemove, onClose }: {
  project: EditableProject;
  /** "remove" opens straight at the remove confirmation (the sidebar's "Remove project"). */
  initialStep?: "edit" | "remove";
  /** The system folder picker; resolves null when cancelled. */
  chooseFolder?: () => Promise<string | null>;
  onSave: (change: ProjectEditSave) => Promise<void>;
  onRemove?: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [folders, setFolders] = useState<string[]>(() => projectFolders(project));
  const [step, setStep] = useState<"edit" | "remove">(initialStep);
  const [busy, setBusy] = useState<"" | "pick" | "save" | "remove">("");
  const [error, setError] = useState("");

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
  const changed = trimmed !== project.name || folders.length !== original.length || folders.some((folder, index) => folder !== original[index]);
  const canSave = Boolean(trimmed) && trimmed.length <= 128 && folders.length > 0 && !busy;
  const save = async () => {
    if (!canSave) return;
    if (!changed) { onClose(); return; }
    setBusy("save"); setError("");
    try {
      await onSave({ name: trimmed, path: folders[0], linkedPaths: folders.slice(1) });
      onClose();
    } catch (cause) { fail(cause); setBusy(""); }
  };
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
            <p className="cx-modal-hint">Its folders and files stay on disk and are not deleted, and its chats are kept. Add the folder again with New project to bring it back.</p>
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
            {error ? <p className="cx-modal-error" role="alert">{error}</p> : null}
          </div>
          <footer className="cx-modal-foot">
            <button type="button" className="cx-modal-button is-danger-soft" onClick={() => { setError(""); setStep("remove"); }}
              disabled={!onRemove || Boolean(busy)} title="Remove this project from Coding Tools; no files are deleted">Remove local project</button>
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
