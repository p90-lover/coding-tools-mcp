<script lang="ts">
 import { GitBranch, Plus } from 'lucide-svelte';
 import { builtinProviderProfiles } from '../../runtime-web/src/provider-registry';
 let stages=['Planner','Coder','Reviewer','Tester'];
 let selected=stages.map(()=>builtinProviderProfiles[0]?.id ?? 'commandcode-proxy');
 let retry=2;
 let parallel=false;
</script>
<section class="cc-page">
<header class="cc-page-heading"><div><h1><GitBranch size={18}/> Anneal Orchestrator Builder</h1><p>Create structured workflows with provider selection, fallback and execution rules.</p></div></header>
<section class="cc-panel">
<button class="cc-button primary"><Plus size={14}/> New Orchestrator</button>
{#each stages as stage, index}
<article class="stage">
<strong>{index+1}. {stage}</strong>
<select bind:value={selected[index]}>
{#each builtinProviderProfiles as provider}<option value={provider.id}>{provider.name}</option>{/each}
</select>
</article>
{/each}
<label><input type="checkbox" bind:checked={parallel}/> Allow parallel stages</label>
<label>Retry <input type="number" min="0" max="10" bind:value={retry}/></label>
<label><input type="checkbox" checked/> Require approval before execution</label>
</section>
</section>
<style>.stage{display:flex;gap:1rem;padding:1rem 0;border-bottom:1px solid var(--border)}select{padding:.4rem}</style>
