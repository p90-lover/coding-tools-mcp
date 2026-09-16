<script lang="ts">
 import { ShieldCheck, RefreshCw, Plug, Settings2, Cpu } from '@lucide/svelte';
 import { builtinProviderProfiles } from '../../runtime-web/src/provider-registry';
</script>
<section class="cc-page">
<header class="cc-page-heading"><div><h1><Cpu size={18}/> Providers</h1><p>API key, OAuth, browser and reverse proxy provider management.</p></div><span class="cc-inline-label"><ShieldCheck size={16}/> Provider execution requires consent</span></header>
<div class="provider-grid">
{#each builtinProviderProfiles as provider}
<article class="cc-panel provider-card">
<h2>{provider.name}</h2>
<p>{provider.category} · {provider.auth}</p>
<strong>Available</strong>
<div class="caps">{#each provider.capabilities as cap}<span>{cap}</span>{/each}</div>
<small>Engines: {provider.paseoEnabled?'Paseo':''}{provider.paseoEnabled&&provider.annealEnabled?', ':''}{provider.annealEnabled?'Anneal':''}</small>
<div class="buttons"><button class="cc-button secondary"><Plug size={14}/>Connect</button><button class="cc-button ghost"><RefreshCw size={14}/>Models</button><button class="cc-button ghost"><Settings2 size={14}/>Edit</button></div>
</article>
{/each}
</div>
</section>
<style>
.provider-grid{display:grid;grid-template-columns:repeat(3,minmax(250px,1fr));gap:1rem}.provider-card{padding:1rem}.caps{display:flex;gap:.4rem;flex-wrap:wrap;margin:1rem 0}.caps span{padding:.25rem .5rem;border:1px solid var(--border);border-radius:999px;font-size:.75rem}.buttons{display:flex;gap:.5rem;flex-wrap:wrap}@media(max-width:900px){.provider-grid{grid-template-columns:1fr}}
</style>
