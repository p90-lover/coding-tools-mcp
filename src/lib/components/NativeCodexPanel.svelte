<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { open } from "@tauri-apps/plugin-dialog";
  import type { WorkspaceProfile } from "$lib/types";

  interface NativeEvent { cursor: number; method: string; text: string; truncated?: boolean }
  interface Approval { request_id: string; method: string; params: unknown; expires_in_seconds: number }
  interface Snapshot {
    connected: boolean; busy?: boolean; started?: boolean; generation?: string;
    thread_id?: string; waiting_for_local_approval?: boolean;
    policy?: {sandbox:string;approval:string;network:boolean;cwd:string;writableRoots:string[]};
    events: NativeEvent[]; approvals?: Approval[]; next_cursor:number; has_more:boolean; history_truncated?:boolean;
  }
  let { profile }: { profile: WorkspaceProfile } = $props();
  let binary = $state("");
  let network = $state(false);
  let prompt = $state("");
  let loading = $state(false);
  let error = $state("");
  let output = $state("");
  let snapshot = $state<Snapshot>({connected:false,events:[],approvals:[],next_cursor:0,has_more:false});
  let cursor = 0;
  let generation = "";
  let reading = false;
  let rerun = false;
  let mounted = false;

  async function refresh() {
    if (reading) { rerun=true; return; }
    reading=true;
    try {
      do {
        rerun=false;
        const result=await invoke<Snapshot>("native_codex_snapshot",{id:profile.id,cursor});
        if (!mounted) return;
        if (result.generation && result.generation!==generation) {
          const oldCursor=cursor;
          generation=result.generation; cursor=0; output="";
          snapshot=result;
          if (oldCursor>0) { rerun=true; continue; }
        }
        snapshot=result;
        if (result.history_truncated) output="[Earlier output is no longer retained / 較早輸出已超過保留上限]\n";
        for (const event of result.events) {
          if (event.cursor<=cursor) continue;
          output += `[${event.method}] ${event.text}${event.truncated ? " [truncated]" : ""}\n`;
        }
        output=output.slice(-65536);
        cursor=result.next_cursor;
        if (result.has_more) rerun=true;
      } while (rerun && mounted);
    } catch (e) { if (mounted) error=String(e); }
    finally { reading=false; }
  }

  async function action(work: () => Promise<unknown>) {
    if (loading) return;
    loading=true; error="";
    try { await work(); await refresh(); }
    catch(e) { error=String(e); }
    finally { loading=false; }
  }
  async function choose() {
    const selected=await open({multiple:false,directory:false,title:"Select official native Codex executable / 選擇官方原生 Codex 執行檔"});
    if (typeof selected === "string") binary=selected;
  }
  async function send() {
    const text=prompt;
    await action(async()=>{
      await invoke("native_codex_submit", {id:profile.id,prompt:text,requestId:crypto.randomUUID(),continuation:!!snapshot.started});
      prompt="";
    });
  }
  async function decide(item:Approval,decision:string) {
    await action(()=>invoke("native_codex_approve",{id:profile.id,generation:snapshot.generation,requestId:item.request_id,decision}));
  }
  onMount(()=>{
    mounted=true;
    let unlisten: (()=>void)|undefined;
    void listen<{workspaceId:string}>("native-codex-update",event=>{
      if (event.payload.workspaceId===profile.id) void refresh();
    }).then(fn=>{if(mounted)unlisten=fn;else fn();}).catch(e=>{error=String(e);});
    void refresh();
    return ()=>{mounted=false;unlisten?.();};
  });
</script>

<section class="tx-card mt-4 grid gap-4 p-5" aria-label="Native Codex">
  <header>
    <p class="tx-section-label">Native Codex · 原生 Codex</p>
    <h3 class="text-lg font-semibold">Official execution engine, not a permission imitation</h3>
    <p class="mt-1 text-sm text-[var(--color-text-muted)]">官方執行後端，不是模擬權限。請先安裝及登入 Codex CLI 0.153.4。Windows 的原生沙箱需先在 Codex 完成設定；設定失敗不會退回無沙箱執行。</p>
  </header>
  <p class="text-sm text-[var(--color-text-muted)]">Select the trusted native binary outside your projects. The native engine uses your existing Codex login, provider, skills and tools. It may consume your account quota. Start/restart MCP or Actions before connecting to authorize that listener; changed listeners require local reconnection. 本機批准不會由遠端 confirm=true 取代。</p>
  <label class="grid gap-1 text-sm">
    <span>Native binary / 原生執行檔（Windows 請選 .exe，不是 .cmd）</span>
    <div class="flex gap-2">
      <input class="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono" bind:value={binary} disabled={snapshot.connected||loading} placeholder="Absolute path to codex / codex.exe" />
      <button class="tx-btn-ghost" type="button" disabled={snapshot.connected||loading} onclick={()=>void action(choose)}>Browse / 選擇</button>
    </div>
  </label>
  <label class="flex items-center gap-2 text-sm">
    <input type="checkbox" bind:checked={network} disabled={snapshot.connected||loading||profile.runtime.permission_mode!=="workspace-write"} />
    <span>Allow command network in workspace-write / 允許工作區命令連網（預設關閉）</span>
  </label>
  <p class="text-sm text-[var(--color-text-muted)]">Read-only defaults to blocked command networking. Full access disables Codex sandbox restrictions and permits network access regardless of this checkbox. File-preservation instructions are not an OS-level deletion prohibition. Full access 並非受限工作區；請保留備份。</p>
  <div class="flex flex-wrap gap-2">
    <button class="tx-btn-primary" type="button" disabled={loading||snapshot.connected||!binary.trim()} onclick={()=>void action(()=>invoke("native_codex_connect",{id:profile.id,binary,network}))}>Connect / 連線</button>
    <button class="tx-btn-ghost" type="button" disabled={loading} onclick={()=>void action(()=>invoke("native_codex_disconnect",{id:profile.id}))}>Disconnect & stop / 斷線並停止</button>
    <button class="tx-btn-ghost" type="button" disabled={loading||!snapshot.busy} onclick={()=>void action(()=>invoke("native_codex_interrupt",{id:profile.id}))}>Interrupt / 中止</button>
    <button class="tx-btn-ghost" type="button" disabled={loading} onclick={()=>void refresh()}>Refresh / 重新整理</button>
  </div>
  {#if error}<p class="rounded border border-[var(--danger)] p-3 text-sm" role="alert">{error}</p>{/if}
  <div class="rounded bg-[var(--color-bg)] p-3 text-sm">
    <strong>{snapshot.connected ? "Connected / 已連線" : "Not connected / 未連線"}</strong>
    {#if snapshot.policy}
      <p>Sandbox: {snapshot.policy.sandbox} · Approval: {snapshot.policy.approval} · Network: {String(snapshot.policy.network)}</p>
      <p class="break-all">Workspace: {snapshot.policy.cwd}</p>
      <p>{snapshot.busy ? "Native turn running / 任務執行中" : "Idle / 閒置"}</p>
    {/if}
  </div>
  {#each snapshot.approvals ?? [] as item (item.request_id)}
    <section class="grid gap-2 rounded border border-[var(--color-accent)] p-3">
      <h4 class="font-semibold">Local approval required / 需要本機批准</h4>
      <p class="text-sm">{item.method} · expires in {item.expires_in_seconds}s</p>
      <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(item.params,null,2)}</pre>
      <p class="text-xs">Review the complete request, including paths/network scope, before accepting. 請核對所有路徑及網絡範圍。</p>
      <div class="flex flex-wrap gap-2">
        <button class="tx-btn-primary" disabled={loading} onclick={()=>void decide(item,"accept")}>Allow once / 本次允許</button>
        <button class="tx-btn-ghost" disabled={loading} onclick={()=>void decide(item,"acceptForSession")}>Allow session / 此會話允許</button>
        <button class="tx-btn-ghost" disabled={loading} onclick={()=>void decide(item,"decline")}>Decline / 拒絕</button>
        <button class="tx-btn-ghost" disabled={loading} onclick={()=>void decide(item,"cancel")}>Cancel / 取消</button>
      </div>
    </section>
  {/each}
  <form class="grid gap-2" onsubmit={e=>{e.preventDefault();void send();}}>
    <label class="grid gap-1 text-sm"><span>Native task / 原生任務</span>
      <textarea class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-3" rows="4" maxlength="65536" bind:value={prompt} disabled={!snapshot.connected||loading||snapshot.busy}></textarea>
    </label>
    <button class="tx-btn-primary justify-self-end" disabled={!snapshot.connected||loading||snapshot.busy||!prompt.trim()}>{snapshot.started ? "Continue / 繼續" : "Start / 開始"}</button>
  </form>
  <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-[var(--color-bg)] p-3 text-xs" aria-label="Native task output">{output || "No output yet / 尚無輸出"}</pre>
  <p class="text-xs text-[var(--color-text-muted)]">No silent retries and no legacy fallback. Unsupported native interactive requests are declined, not auto-approved. Codex sessions remain in its own data directory after disconnect; nothing is deleted. 沒有自動重播，亦不會因失敗而退回舊版工具。</p>
</section>
