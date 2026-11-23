import { useEffect, useRef, useState, type FormEvent } from "react";
import type { JsonObject } from "../api/contracts";
import "./native-chats.css";

interface Thread { sessionId: string; name: string; state: string }
interface Turn { id: string; prompt: string; answer: string; state: string; error?: string }
interface Pending { sessionId: string | null; inputId: string; text: string; revision: number }
interface Page { turn: Turn | null; cursor: number | null; continuable: boolean; name: string; sessionId: string }

const activeTurn = (turn?: Turn | null) => turn?.state === "queued" || turn?.state === "running";
const nativeCall = <T,>(args: JsonObject): Promise<T> => {
  const runtime = window.codingTools?.runtime;
  return runtime?.chats ? runtime.chats(args) as Promise<T> : Promise.reject(new Error("The native Chats runtime is unavailable"));
};
const scoped = (sessionId: string | null): JsonObject => sessionId === null ? {} : { sessionId };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Native Chats could not confirm the operation";

export function NativeChatsSurface({ active }: { active: boolean }) {
  const [binding, setBinding] = useState<{ available: boolean; ready: boolean; model?: string }>();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [page, setPage] = useState<Page>();
  const [older, setOlder] = useState<Turn[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<string | null>(null);
  const inFlight = useRef(false);
  const draftRevision = useRef(0);

  async function list(after?: string) {
    const result = await nativeCall<{ chats: Thread[]; cursor: string | null }>({ action: "list", ...(after ? { after } : {}) });
    setThreads(items => after ? [...items, ...result.chats.filter(thread => !items.some(item => item.sessionId === thread.sessionId))] : result.chats);
    setThreadCursor(result.cursor);
  }
  async function read(id: string, cursor?: number) {
    const frame = await nativeCall<Page>({ action: "read", sessionId: id, ...(cursor === undefined ? {} : { before: cursor }) });
    if (current.current !== id || frame.sessionId !== id) return;
    if (cursor === undefined) setPage(frame);
    else {
      if (frame.turn) setOlder(turns => turns.some(turn => turn.id === frame.turn?.id) ? turns : [frame.turn!, ...turns]);
      setBefore(frame.cursor);
    }
  }
  useEffect(() => {
    if (!active) return;
    let stale = false;
    void nativeCall<{ available: boolean; ready: boolean; model?: string }>({ action: "status" }).then(result => {
      if (stale) return;
      setBinding(result);
      if (result.ready) return list();
    }).catch(problem => { if (!stale) setError(errorMessage(problem)); });
    return () => { stale = true; };
  }, [active]);
  const polling = activeTurn(page?.turn);
  useEffect(() => {
    if (!active || !sessionId || !polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const frame = await nativeCall<Page>({ action: "read", sessionId });
        if (stopped || current.current !== sessionId || frame.sessionId !== sessionId) return;
        setPage(frame);
        if (activeTurn(frame.turn)) timer = setTimeout(() => void tick(), 500);
      } catch (problem) { if (!stopped) setError(errorMessage(problem)); }
    };
    timer = setTimeout(() => void tick(), 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, sessionId, polling]);

  function choose(id: string | null) {
    current.current = id;
    setSessionId(id);
    setPage(undefined);
    setOlder([]);
    setBefore(null);
  }
  async function work(callback: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try { await callback(); }
    catch (problem) { setError(errorMessage(problem)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function attach(id: string, submitted: Pending) {
    setPending(null);
    if (draftRevision.current === submitted.revision) setText("");
    choose(id);
    await read(id);
    await list();
  }
  function send(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || pending || inFlight.current || !binding?.ready || polling || sessionId && !page?.continuable) return;
    if (new TextEncoder().encode(JSON.stringify(text)).byteLength > 16384) { setError("The message exceeds the 16 KiB native input limit"); return; }
    const submitted = { sessionId, inputId: crypto.randomUUID(), text, revision: draftRevision.current };
    setPending(submitted);
    void work(async () => {
      const accepted = await nativeCall<{ inputId: string; sessionId: string } | { rejected: true; reason: string }>({ action: "send", ...scoped(submitted.sessionId), inputId: submitted.inputId, text: submitted.text });
      if ("rejected" in accepted) { setPending(null); throw new Error(accepted.reason); }
      if (accepted.inputId !== submitted.inputId || !accepted.sessionId.startsWith("native:") || submitted.sessionId && submitted.sessionId !== accepted.sessionId) throw new Error("The reply did not match the saved input");
      await attach(accepted.sessionId, submitted);
    });
  }
  function recover(submitted: Pending) {
    void work(async () => {
      const { receipt } = await nativeCall<{ receipt: { inputId: string; sessionId: string } | null }>({ action: "receipt", ...scoped(submitted.sessionId), inputId: submitted.inputId });
      if (!receipt || receipt.inputId !== submitted.inputId || !receipt.sessionId.startsWith("native:")
        || submitted.sessionId && submitted.sessionId !== receipt.sessionId) throw new Error("No exact receipt was found. The message has not been resent.");
      await attach(receipt.sessionId, submitted);
    });
  }

  const turn = page?.turn;
  return <div className="native-chats">
    <aside aria-label="Native chats">
      <h2>Chats</h2>
      <button disabled={!binding?.ready || busy || !!pending} onClick={() => choose(null)}>+ New chat</button>
      {threads.map(thread => <button key={thread.sessionId} disabled={busy || !!pending} aria-pressed={thread.sessionId === sessionId}
        onClick={() => { choose(thread.sessionId); void work(() => read(thread.sessionId)); }}>{thread.name || "Untitled chat"}</button>)}
      {threadCursor && <button disabled={busy} onClick={() => void work(() => list(threadCursor))}>More chats</button>}
    </aside>
    <section className="native-chats-thread" aria-label="Native Orchestrator conversation">
      <header><strong>{page?.name || "New chat"}</strong><span>Orchestrator · Experimental{binding?.model ? ` · ${binding.model}` : ""}</span></header>
      {!binding?.ready ? <div className="native-chats-empty">
        <h2>Native Orchestrator Chats</h2>
        <p>{binding?.available ? "Open the approved, isolated Chats workspace. No model runs until you send a message." : "Native Chats needs a configured development profile and model binding. The existing Chat page still uses AO."}</p>
        {binding?.available && <button disabled={busy} onClick={() => void work(async () => {
          setBinding(await nativeCall({ action: "open" })); await list();
        })}>Open native Chats</button>}
      </div> : <>
        <div className="native-chats-transcript" aria-label="Transcript">
          {(older.length ? before : page?.cursor) && sessionId && <button disabled={busy} onClick={() => {
            const cursor = older.length ? before : page?.cursor;
            if (cursor) void work(() => read(sessionId, cursor));
          }}>Older messages</button>}
          {[...older, ...(turn && !older.some(item => item.id === turn.id) ? [turn] : [])].map(item => <article key={item.id}>
            <div className="native-chats-message">{item.prompt}</div>
            {item.answer && <div className="native-chats-answer">{item.answer}</div>}
            {item.state !== "completed" && <p role="status">{item.state === "unknown" ? "Delivery unknown. This turn will not be replayed." : item.error || item.state}</p>}
          </article>)}
          {!turn && !sessionId && <div className="native-chats-empty"><h2>Start a native chat</h2><p>Text only. Separate from AO Chat.</p></div>}
        </div>
        {sessionId && page && !page.continuable && <p className="native-chats-status">This conversation is read-only after reopening. Start a new chat to continue.</p>}
        <form className="native-chats-composer" onSubmit={send}>
          <textarea aria-label="Message" placeholder="Message Orchestrator" value={text} onChange={event => {
            draftRevision.current++; setText(event.target.value);
          }} />
          <div>{pending ? <button type="button" disabled={busy} onClick={() => recover(pending)}>Check receipt</button>
            : <button type="submit" disabled={busy || polling || !text.trim() || Boolean(sessionId && !page?.continuable)}>Send</button>}
          </div>
          {pending && <p role="status">{busy ? "Saving…" : "Delivery is not confirmed. Check the exact receipt before submitting again."}</p>}
        </form>
      </>}
      {error && <p className="native-chats-status" role="alert">{error}</p>}
    </section>
  </div>;
}
