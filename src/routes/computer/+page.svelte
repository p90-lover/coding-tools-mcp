<script lang="ts">
 import {page} from '$app/stores';
 import {workspaces} from '$lib/stores/app';
 import {locale,labels} from '$lib/control-center/locale';
 import ComputerControl from '$lib/components/ComputerControl.svelte';
 import {Monitor,ShieldCheck,ArrowUpRight} from '@lucide/svelte';
 import Notice from '$lib/components/center/Notice.svelte';
 let selected=$state('');
 let workspace=$derived($workspaces.find(w=>w.id===(selected||$page.url.searchParams.get('workspace')))||$workspaces[0]);
 let t=$derived(labels[$locale]);
</script>
<section class="page-scroll cc-page cc-computer-page">
 <header class="cc-page-heading"><div><h1>{t.computer}</h1><p>{$locale==='en'?'Observe approved windows. Stay in control of every action.':'觀察已批准的視窗，掌握每一項操作。'}</p></div><span class="cc-badge"><ShieldCheck size={14}/>{$locale==='en'?'Memory-only vision':'記憶體視覺'}</span></header>
 <Notice text={$locale==='en'?'Background observation does not take focus. Mouse and keyboard actions still require an approved foreground target.':'背景觀察不會搶佔焦點；鍵鼠操作仍需要已批准的前台視窗。'}/>
 <div class="cc-toolbar"><label for="computer-workspace">{t.workspaces}</label><select id="computer-workspace" class="cc-input" value={workspace?.id??''} onchange={(event)=>selected=event.currentTarget.value}>{#each $workspaces as w}<option value={w.id}>{w.name}</option>{/each}</select>{#if workspace}<a class="cc-text-link" href={'/workspace/'+workspace.id}>{$locale==='en'?'Service & permissions':'服務及權限'}<ArrowUpRight size={15}/></a>{/if}</div>
 {#if workspace}{#key workspace.id}<ComputerControl workspaceId={workspace.id}/>{/key}{:else}<div class="cc-empty cc-panel"><Monitor size={32}/><h3>{t.empty}</h3><p>{t.emptyHint}</p></div>{/if}
</section>
