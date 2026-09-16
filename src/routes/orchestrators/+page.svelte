<script lang="ts">
 import { GitBranch, Plus } from 'lucide-svelte';
 let stages=['Planner','Coder','Reviewer','Tester'];
</script>
<section class="cc-page">
<header class="cc-page-heading"><div><h1><GitBranch size={18}/> Anneal Orchestrator Builder</h1><p>Create structured workflows with provider selection per stage.</p></div></header>
<section class="cc-panel">
<button class="cc-button primary"><Plus size={14}/> New Orchestrator</button>
{#each stages as stage, index}
<article class="stage">
<strong>{index+1}. {stage}</strong>
<select><option>Claude OAuth</option><option>Codex OAuth</option><option>Gemini Reverse Proxy</option><option>CommandCode Proxy</option></select>
</article>
{/each}
<label><input type="checkbox" checked/> Require approval before execution</label>
</section>
</section>
<style>.stage{display:flex;gap:1rem;padding:1rem 0;border-bottom:1px solid var(--border)}select{padding:.4rem}</style>
