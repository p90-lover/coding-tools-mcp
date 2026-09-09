<script lang="ts">
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { workspaces } from '$lib/stores/app';
  import { locale } from '$lib/control-center/state';
  type Question = {id:string;header:string;question:string;options:{label:string;description:string}[]};
  type Pending = {workspace_id:string;service:string;request:{request_id:string;answer_nonce:string;questions:Question[];remaining_seconds:number}};
  let pending = $state<Pending[]>([]);
  let values = $state<Record<string,string>>({});
  let free = $state<Record<string,string>>({});
  let busy = $state(false);
  let error = $state('');
  const current = $derived(pending[0]);
  const key = $derived(current ? `${current.workspace_id}:${current.service}:${current.request.request_id}:${current.request.answer_nonce}` : '');
  const zh = $derived($locale === 'zh-Hant');
  $effect(() => { key; values={};free={};error=''; });
  async function poll() { try { pending=await invoke<Pending[]>('human_pending'); } catch { /* Never fabricate a question or answer on IPC failure. */ } }
  async function answer(cancel=false) {
    const target=current;if(!target||busy)return;
    const answers:Record<string,{answers:string[]}>= {};
    if(!cancel) for(const q of target.request.questions) {
      const value=values[q.id]==='__other' ? free[q.id]?.trim() : values[q.id];
      if(!value){error=zh?'請回答每條問題。':'Please answer each question.';return;}
      answers[q.id]={answers:[value]};
    }
    busy=true;error='';
    try { await invoke('human_answer',{workspaceId:target.workspace_id,service:target.service,requestId:target.request.request_id,answerNonce:target.request.answer_nonce,answers,cancel});await poll(); }
    catch(e){error=String(e);}finally{busy=false;}
  }
  onMount(() => {
    let alive=true;let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{if(!alive)return;await poll();if(alive)timer=setTimeout(tick,2000);};
    void tick();return()=>{alive=false;clearTimeout(timer);};
  });
</script>
{#if current}
<aside class="questions" aria-label={zh?'AI 等待你的答案':'AI is waiting for your answer'}>
  <header><strong>{zh?'需要你的意見':'Your input is needed'}</strong><small>{pending.length} · {current.request.remaining_seconds}s</small></header>
  <p class="workspace">{$workspaces.find(w=>w.id===current.workspace_id)?.name ?? current.workspace_id} · {current.service.toUpperCase()}</p>
  <p class="notice">{zh?'回答只會回傳你的選擇，不會授予權限或執行操作。不要輸入密碼或 Token。':'Answers return your choice only: no permission grant or action is executed. Do not enter passwords or tokens.'}</p>
  <form onsubmit={(e)=>{e.preventDefault();void answer();}}>
    {#each current.request.questions as q(q.id)}
      <fieldset disabled={busy}>
        <legend>{q.header}</legend><label for={`human-${q.id}`}>{q.question}</label>
        <select id={`human-${q.id}`} value={values[q.id]??''} onchange={(e)=>values={...values,[q.id]:e.currentTarget.value}}>
          <option value="" disabled>{zh?'選擇答案':'Choose an answer'}</option>
          {#each q.options as option}<option value={option.label}>{option.label}</option>{/each}
          <option value="__other">{zh?'其他答案':'Other answer'}</option>
        </select>
        {#if values[q.id]==='__other'}<input aria-label={zh?'其他答案':'Other answer'} maxlength="1024" value={free[q.id]??''} oninput={(e)=>free={...free,[q.id]:e.currentTarget.value}} />
        {:else}<small>{q.options.find(o=>o.label===values[q.id])?.description??''}</small>{/if}
      </fieldset>
    {/each}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    <footer><button type="button" disabled={busy} onclick={()=>void answer(true)}>{zh?'取消問題':'Cancel question'}</button><button class="primary" disabled={busy} type="submit">{busy?'…':zh?'傳送答案':'Send answers'}</button></footer>
  </form>
</aside>
{/if}
<style>
.questions{position:fixed;right:20px;bottom:20px;z-index:70;width:min(420px,calc(100vw - 40px));max-height:80vh;overflow:auto;padding:20px;border:1px solid var(--color-border);border-radius:14px;background:var(--color-bg-elevated,#1b1d25);color:var(--color-text-primary,#e8e9ee);box-shadow:0 12px 40px #0005;font-size:13px}header,footer{display:flex;justify-content:space-between;gap:12px;align-items:center}strong{font-size:16px}.workspace,small,.notice{color:var(--color-text-muted,#aaa)}.workspace{margin:7px 0}.notice{font-size:12px;line-height:1.6}fieldset{border:0;padding:0;margin:15px 0;display:grid;gap:7px}legend{font-weight:600;margin-bottom:5px}label{line-height:1.5}select,input{width:100%;padding:9px;border:1px solid var(--color-border);border-radius:7px;background:var(--color-bg,#14151b);color:inherit}button{padding:8px 14px;border:1px solid var(--color-border);border-radius:7px;color:inherit;background:transparent;cursor:pointer}.primary{background:var(--color-accent,#818cf8);color:#fff}button:disabled{opacity:.5;cursor:wait}.error{color:#f87171;overflow-wrap:anywhere}footer{justify-content:flex-end;margin-top:14px}
</style>
