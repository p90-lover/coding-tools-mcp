import type { ChatAttachment } from "./ao-chat";
import type { DraftAnnotation } from "./ChatAnnotations";

export type SavedChatDraft = {
  text: string;
  attachments: ChatAttachment[];
  annotations: Omit<DraftAnnotation, "id">[];
  selection?: Record<string, unknown>;
};
export type DraftStatus = "idle" | "saving" | "saved" | "unsaved";
export type DurableDraftReceipt = { revision: number; draft: SavedChatDraft | null; updatedAt: number | null };
export type DraftSaveResult = DurableDraftReceipt & { duplicate?: boolean; conflict?: boolean; conflictId?: string };
export type AcceptMode = "send" | "queue" | "steer";
export type AcceptDestination = {
  message: string; taskId?: string; title?: string; goal?: string;
  executionMode?: "single" | "team"; singleRoute?: Record<string, unknown>; teamId?: string;
  teamRevision?: number; executable?: string; restart?: boolean;
  rewind?: { index: number; description: string };
};
export type AcceptInputArgs = { key: string; inputId: string; mode: AcceptMode; draftRevision?: number; payload: SavedChatDraft; destination: AcceptDestination };
export type AcceptReceipt = {
  ok: true; inputId: string; state: string; payload: SavedChatDraft; destination: AcceptDestination;
  draft: DurableDraftReceipt; duplicate?: boolean;
};
export type PendingChatInput = { inputId: string; mode: AcceptMode; state: "queued" | "dispatching" | "unknown"; destination: AcceptDestination };
export type PendingInputPage = { items: PendingChatInput[]; cursor: number; hasMore: boolean };
export type ModuleCallFn = (operation: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;

export async function chatInputPending(moduleCall: ModuleCallFn, workspaceId: string, key: string, after = 0): Promise<PendingInputPage> {
  if (!Number.isSafeInteger(after) || after < 0) throw invalidReceipt();
  const { ok, cursor, hasMore, items } = await moduleCall("chat_input", { workspaceId, action: "pending", key, after });
  if (ok !== true || typeof cursor !== "number" || !Number.isSafeInteger(cursor) || typeof hasMore !== "boolean"
    || !Array.isArray(items) || items.length > 25 || (items.length ? cursor <= after : cursor !== after || hasMore)) throw invalidReceipt();
  const ids = new Set<string>();
  const pending = items.map(item => {
    if (!item || item.workspaceId !== workspaceId || item.key !== key || typeof item.inputId !== "string" || !item.inputId || ids.has(item.inputId)
      || !["send", "queue", "steer"].includes(item.mode) || !["queued", "dispatching", "unknown"].includes(item.state)
      || typeof item.destination?.message !== "string") throw invalidReceipt();
    ids.add(item.inputId);
    return item as PendingChatInput;
  });
  return { items: pending, cursor, hasMore };
}

export const ACCEPT_DESTINATION_FIELDS = new Set(["message", "taskId", "title", "goal", "executionMode", "singleRoute", "teamId", "teamRevision", "executable", "restart", "rewind"]);
const invalidReceipt = () => Object.assign(new Error("The app did not return a durable input receipt; your composer was kept"), { code: "INPUT_RECEIPT_INVALID" });

export function createUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  throw new Error("Secure input identifiers are unavailable in this window");
}
export function buildAcceptDestination(raw: Record<string, unknown>): AcceptDestination {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("Choose a chat destination"), { code: "INPUT_INVALID" });
  const message = typeof raw.message === "string" ? raw.message : "";
  if (!message.trim() || message.length > 8192) throw Object.assign(new Error("Chat messages must contain 1 to 8192 characters"), { code: "INPUT_INVALID" });
  const destination: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (!ACCEPT_DESTINATION_FIELDS.has(key)) throw Object.assign(new Error(`Unsupported chat destination field: ${key}`), { code: "INPUT_INVALID" });
    destination[key] = value;
  }
  return { ...destination, message } as AcceptDestination;
}
export function rebuildAttachmentMessage(message: string, originals: readonly ChatAttachment[], preserved: readonly ChatAttachment[]): string {
  const replacements = new Map<string, string>();
  originals.forEach((item, index) => {
    const stored = preserved[index];
    if (!item.path || !stored?.path) return;
    const prefix = item.image ? "Attached image: " : "Attached file: ";
    replacements.set(prefix + item.path, prefix + stored.path);
  });
  return message.split("\n").map(line => replacements.get(line) ?? line).join("\n");
}
export function mergePersistedAttachments(current: ChatAttachment[], submitted: ChatAttachment[], preserved: ChatAttachment[]): ChatAttachment[] {
  let changed = false;
  const next = current.map(item => {
    const index = submitted.findIndex(original => original === item || original.name === item.name && original.path === item.path && original.text === item.text && original.blobId === item.blobId);
    const stored = index < 0 ? null : preserved[index];
    if (!stored?.path || !stored.blobId || item.path === stored.path && item.blobId === stored.blobId) return item;
    changed = true;
    return { ...item, path: stored.path, blobId: stored.blobId };
  });
  return changed ? next : current;
}
export function sameAttachmentSnapshot(current: ChatAttachment[], submitted: ChatAttachment[], preserved: ChatAttachment[] = submitted): boolean {
  return current.length === submitted.length && current.every((item, index) => {
    const original = submitted[index], stored = preserved[index];
    return item.name === original.name && item.text === original.text && item.image === original.image && item.markup === original.markup
      && (item.path === original.path || Boolean(stored?.blobId && item.blobId === stored.blobId && item.path === stored.path));
  });
}
function isDraft(value: unknown): value is SavedChatDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as SavedChatDraft;
  return typeof draft.text === "string" && Array.isArray(draft.attachments) && Array.isArray(draft.annotations);
}
export function readDraftReceipt(value: unknown): DurableDraftReceipt {
  if (!value || typeof value !== "object") throw invalidReceipt();
  const receipt = value as DurableDraftReceipt;
  if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 0 || !(receipt.draft === null || isDraft(receipt.draft))) throw invalidReceipt();
  return { revision: receipt.revision, draft: receipt.draft, updatedAt: typeof receipt.updatedAt === "number" ? receipt.updatedAt : null };
}
export function readAcceptReceipt(value: unknown, inputId: string): AcceptReceipt {
  if (!value || typeof value !== "object") throw invalidReceipt();
  const receipt = value as AcceptReceipt;
  if (receipt.ok !== true || receipt.inputId !== inputId || !["queued", "dispatching", "unknown", "accepted", "completed", "failed", "cancelled"].includes(receipt.state)
    || !isDraft(receipt.payload) || !receipt.destination || typeof receipt.destination.message !== "string") throw invalidReceipt();
  return { ok: true, inputId, state: receipt.state, payload: receipt.payload, destination: receipt.destination,
    draft: readDraftReceipt(receipt.draft), duplicate: receipt.duplicate === true };
}
export async function chatInputDraftGet(moduleCall: ModuleCallFn, workspaceId: string, key: string): Promise<DurableDraftReceipt> {
  const response = await moduleCall("chat_input", { workspaceId, action: "draft_get", key });
  if (response?.ok !== true) throw invalidReceipt();
  return readDraftReceipt(response);
}
export async function chatInputDraftSave(moduleCall: ModuleCallFn, workspaceId: string, key: string, expectedRevision: number, mutationId: string, draft: SavedChatDraft | null): Promise<DraftSaveResult> {
  const response = await moduleCall("chat_input", { workspaceId, action: "draft_save", key, expectedRevision, mutationId, draft });
  if (response?.ok !== true) throw invalidReceipt();
  return { ...readDraftReceipt(response), duplicate: response.duplicate === true, conflict: response.conflict === true,
    ...(typeof response.conflictId === "string" ? { conflictId: response.conflictId } : {}) };
}
export async function chatInputAccept(moduleCall: ModuleCallFn, workspaceId: string, args: AcceptInputArgs): Promise<AcceptReceipt> {
  const destination = buildAcceptDestination(args.destination as Record<string, unknown>);
  const response = await moduleCall("chat_input", { workspaceId, action: "accept", key: args.key, inputId: args.inputId, mode: args.mode,
    ...(args.draftRevision === undefined ? {} : { draftRevision: args.draftRevision }), payload: args.payload, destination });
  return readAcceptReceipt(response, args.inputId);
}

function draftFingerprint(draft: SavedChatDraft | null): string {
  return JSON.stringify(draft, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
}

type SaveAttempt = { draft: SavedChatDraft | null; json: string; expectedRevision: number; mutationId: string };
export type DraftCoalescerOptions = {
  key: string; workspaceId: string; moduleCall: ModuleCallFn;
  debounceMs?: number; maxWaitMs?: number;
  onStatusChange?: (status: DraftStatus, message?: string) => void;
  onAttachmentsUpdated?: (attachments: ChatAttachment[], submitted: SavedChatDraft) => void;
  onConflict?: (conflict: { conflictId?: string; revision: number; draft: SavedChatDraft | null }) => void;
};

export class DraftCoalescer {
  private revision = 0;
  private status: DraftStatus = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstChangeAt: number | null = null;
  private inFlight: Promise<void> | null = null;
  private handoff: Promise<void> | null = null;
  private pending: SavedChatDraft | null | undefined;
  private retry: SaveAttempt | null = null;
  private savedJson: string | null = null;
  private snapshots = new Map<string, SavedChatDraft | null>();
  private conflict = false;
  private disposed = false;
  constructor(private options: DraftCoalescerOptions) {}
  public setKnownRevision(revision: number, savedJson?: string | null): void {
    if (!Number.isSafeInteger(revision) || revision < 0) throw invalidReceipt();
    this.revision = Math.max(this.revision, revision);
    if (savedJson !== undefined) this.savedJson = savedJson === null ? null : draftFingerprint(JSON.parse(savedJson));
  }
  public pauseForAcceptance(): (receipt?: DurableDraftReceipt, submitted?: SavedChatDraft) => void {
    if (this.handoff) throw new Error("A draft acceptance is already in progress");
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    let resume!: () => void;
    this.handoff = new Promise<void>(resolve => { resume = resolve; });
    let released = false;
    return (receipt, submitted) => {
      if (released) return;
      released = true;
      if (receipt) {
        this.setKnownRevision(receipt.revision, JSON.stringify(receipt.draft));
        if (submitted && this.pending !== undefined && draftFingerprint(this.pending) === draftFingerprint(submitted)) this.pending = undefined;
      }
      this.handoff = null;
      resume();
      if (this.pending !== undefined && !this.disposed) void this.flush();
    };
  }
  public getKnownRevision(): number { return this.revision; }
  public getStatus(): DraftStatus { return this.status; }
  public preservedDraft(draft: SavedChatDraft): SavedChatDraft { return this.snapshots.get(draftFingerprint(draft)) ?? draft; }
  public matchesSaved(draft: SavedChatDraft | null): boolean { return !this.conflict && !this.retry && draftFingerprint(draft) === this.savedJson; }
  private setStatus(status: DraftStatus, message?: string): void { this.status = status; this.options.onStatusChange?.(status, message); }
  public queueChange(draft: SavedChatDraft | null): void {
    if (this.disposed) return;
    if (!this.retry && !this.inFlight && this.pending === undefined && this.matchesSaved(draft)) return;
    this.pending = draft;
    if (this.conflict) return;
    this.setStatus("saving");
    if (this.handoff) return;
    this.firstChangeAt ??= Date.now();
    if (this.timer !== null) clearTimeout(this.timer);
    const wait = Math.min(this.options.debounceMs ?? 250, Math.max(0, (this.options.maxWaitMs ?? 500) - (Date.now() - this.firstChangeAt)));
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, wait);
  }
  public async flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.firstChangeAt = null;
    if (this.handoff) await this.handoff;
    if (this.disposed || this.conflict) return;
    if (this.inFlight) { await this.inFlight; return; }
    const run = async () => {
      while (!this.conflict && (this.retry || this.pending !== undefined)) {
        const attempt: SaveAttempt = this.retry ?? { draft: this.pending!, json: draftFingerprint(this.pending!), expectedRevision: this.revision, mutationId: createUuid() };
        if (!this.retry) this.pending = undefined;
        if (!this.retry && attempt.json === this.savedJson) continue;
        try {
          const result = await chatInputDraftSave(this.options.moduleCall, this.options.workspaceId, this.options.key,
            attempt.expectedRevision, attempt.mutationId, attempt.draft);
          this.revision = Math.max(this.revision, result.revision);
          this.retry = null;
          if (result.conflict) {
            this.conflict = true;
            this.setStatus("unsaved", "This draft changed in another window. Your attempted text was preserved for recovery.");
            this.options.onConflict?.(result);
            return;
          }
          this.savedJson = draftFingerprint(result.draft);
          this.snapshots.set(attempt.json, result.draft);
          if (this.snapshots.size > 16) this.snapshots.delete(this.snapshots.keys().next().value!);
          if (attempt.draft && result.draft) this.options.onAttachmentsUpdated?.(result.draft.attachments, attempt.draft);
        } catch (error) {
          this.retry = attempt;
          this.setStatus("unsaved", error instanceof Error ? error.message : String(error));
          return;
        }
      }
      this.setStatus(this.savedJson === "null" ? "idle" : "saved");
    };
    this.inFlight = run();
    try { await this.inFlight; } finally { this.inFlight = null; }
  }
  public async dispose(): Promise<void> {
    await this.flush();
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
