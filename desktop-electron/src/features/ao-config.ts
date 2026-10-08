type Scope = { workspaceId: string; taskId: string; runId?: string };
type TeamDraft = { id: string; workspace_id?: string; name?: string; worker_limit?: number; max_review_rounds?: number;
  nodes: Array<{ id: string; role: string; parents?: string[]; route: unknown; settings?: Record<string, unknown> }> };
type State = { scope: Scope; draft: TeamDraft; version: number; phase: "applying" | "applied" | "error"; result?: unknown; error?: unknown };
type Entry = { scope: Scope; draft: TeamDraft; signature: string; version: number; ready: boolean };

export function configurationSignature(team: TeamDraft): string {
  return JSON.stringify({ id: team.id, name: team.name, worker_limit: team.worker_limit,
    max_review_rounds: team.max_review_rounds,
    nodes: team.nodes.map(node => {
      const { revision: _revision, ...settings } = node.settings ?? {};
      return { id: node.id, role: node.role, parents: node.parents, route: node.route, settings };
    }) });
}

export function createLatestConfigQueue({
  apply, onState, setTimer = setTimeout, clearTimer = clearTimeout, delayMs = 350,
}: {
  apply: (scope: Scope, draft: TeamDraft) => Promise<unknown>;
  onState: (state: State) => void;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
  delayMs?: number;
}) {
  const pending = new Map<string, Entry>(), active = new Map<string, Entry>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>(), applied = new Map<string, string>();
  const jobs = new Map<string, Promise<void>>(), latest = new Map<string, number>(), flushing = new Set<string>();
  let version = 0, disposed = false;
  const keyOf = (scope: Scope) => JSON.stringify([scope.workspaceId, scope.taskId, scope.runId ?? null]);
  function clear(key: string) { const timer = timers.get(key); if (timer !== undefined) clearTimer(timer); timers.delete(key); }
  function drain(key: string): Promise<void> {
    if (disposed) return Promise.resolve();
    const running = jobs.get(key);
    if (running) return running;
    if (!pending.get(key)?.ready) return Promise.resolve();
    const job = Promise.resolve().then(async () => {
      while (!disposed && pending.get(key)?.ready) {
        const entry = pending.get(key)!;
        pending.delete(key); clear(key);
        if (applied.get(key) === entry.signature) continue;
        active.set(key, entry); onState({ ...entry, phase: "applying" });
        try {
          const result = await apply(entry.scope, entry.draft);
          applied.set(key, entry.signature);
          if (!disposed && latest.get(key) === entry.version) onState({ ...entry, phase: "applied", result });
        } catch (error) {
          if (!disposed && latest.get(key) === entry.version) onState({ ...entry, phase: "error", error });
        } finally { active.delete(key); }
      }
    }).finally(() => {
      jobs.delete(key);
      if (!disposed && pending.get(key)?.ready) void drain(key);
    });
    jobs.set(key, job);
    return job;
  }
  return {
    enqueue(scope: Scope, draft: TeamDraft, { immediate = false }: { immediate?: boolean } = {}) {
      if (disposed) return;
      const key = keyOf(scope), signature = configurationSignature(draft);
      clear(key);
      const current = active.get(key);
      if ((!jobs.has(key) && applied.get(key) === signature) || current?.signature === signature) {
        pending.delete(key); if (current) latest.set(key, current.version); return;
      }
      const entry: Entry = { scope: structuredClone(scope), draft: structuredClone(draft), signature,
        version: ++version, ready: immediate || flushing.has(key) };
      latest.set(key, entry.version); pending.set(key, entry);
      if (entry.ready) void drain(key);
      else timers.set(key, setTimer(() => { timers.delete(key); entry.ready = true; void drain(key); }, delayMs));
    },
    async flush(scope: Scope) {
      const key = keyOf(scope), entry = pending.get(key);
      clear(key); flushing.add(key); if (entry) entry.ready = true;
      try {
        await drain(key);
        while (!disposed && pending.get(key)?.ready) await drain(key);
      } finally { flushing.delete(key); }
    },
    cancel(scope: Scope) {
      const key = keyOf(scope); clear(key); pending.delete(key); latest.set(key, ++version);
    },
    dispose() {
      disposed = true; for (const key of timers.keys()) clear(key); pending.clear();
    },
  };
}
