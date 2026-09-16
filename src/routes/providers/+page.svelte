<script lang="ts">
 import { ShieldCheck, RefreshCw, Plug, Settings2, Cpu } from '@lucide/svelte';
 type Provider={name:string;type:string;auth:string;status:string;caps:string[];models:string[];engines:string[]};
 const providers:Provider[]=[
  {name:'Codex OAuth',type:'OAuth',auth:'OAuth',status:'Ready',caps:['text','reasoning','tools'],models:[],engines:['Paseo','Anneal']},
  {name:'Claude OAuth',type:'OAuth',auth:'OAuth',status:'Ready',caps:['text','reasoning','tools'],models:[],engines:['Paseo','Anneal']},
  {name:'AI Studio Reverse Proxy',type:'Reverse Proxy',auth:'Browser Session',status:'Available',caps:['text','vision','image'],models:[],engines:['Paseo','Anneal']},
  {name:'Gemini Reverse Proxy',type:'Reverse Proxy',auth:'API / OAuth',status:'Available',caps:['text','vision','tools','image'],models:[],engines:['Paseo','Anneal']},
  {name:'AIStudioToAPI',type:'API Bridge',auth:'Local Key',status:'Available',caps:['text','vision','image'],models:[],engines:['Paseo','Anneal']},
  {name:'CommandCode Proxy',type:'Reverse Proxy',auth:'Router Credential',status:'Available',caps:['text','reasoning','tools'],models:[],engines:['Paseo','Anneal']}
 ];
</script>
<section class="cc-page">
<header class="cc-page-heading"><div><h1><Cpu size={18}/> Providers</h1><p>API key, OAuth, browser and reverse proxy provider management.</p></div><span class="cc-inline-label"><ShieldCheck size={16}/> Provider execution requires consent</span></header>
<div class="provider-grid">
{#each providers as provider}
<article class="cc-panel provider-card">
<h2>{provider.name}</h2>
<p>{provider.type} · {provider.auth}</p>
<strong>{provider.status}</strong>
<div class="caps">{#each provider.caps as cap}<span>{cap}</span>{/each}</div>
<small>Engines: {provider.engines.join(', ')}</small>
<div class="buttons"><button class="cc-button secondary"><Plug size={14}/>Connect</button><button class="cc-button ghost"><RefreshCw size={14}/>Models</button><button class="cc-button ghost"><Settings2 size={14}/>Edit</button></div>
</article>
{/each}
</div>
</section>
<style>
.provider-grid{display:grid;grid-template-columns:repeat(3,minmax(250px,1fr));gap:1rem}.provider-card{padding:1rem}.caps{display:flex;gap:.4rem;flex-wrap:wrap;margin:1rem 0}.caps span{padding:.25rem .5rem;border:1px solid var(--border);border-radius:999px;font-size:.75rem}.buttons{display:flex;gap:.5rem;flex-wrap:wrap}@media(max-width:900px){.provider-grid{grid-template-columns:1fr}}
</style>