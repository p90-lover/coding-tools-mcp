<script lang="ts">
 import {onMount} from 'svelte';
 import {ShieldCheck,ArrowUpRight,Cable} from '@lucide/svelte';
 import {center,centerError,loadCenter} from '$lib/control-center/api';
 import {locale,labels} from '$lib/control-center/locale';
 import {workspaces} from '$lib/stores/app';
 import ConnectionCard from '$lib/components/center/ConnectionCard.svelte';
 import Notice from '$lib/components/center/Notice.svelte';
 let t=$derived(labels[$locale]);onMount(()=>{void loadCenter().catch(()=>{});});
</script>
<section class="page-scroll cc-page">
 <header class="cc-page-heading"><div><h1>{t.connections}</h1><p>{$locale==='en'?'Bring your existing tools together. Keep their execution separate.':'連接既有工具，將執行權限保持獨立。'}</p></div><span class="cc-badge"><ShieldCheck size={15}/>{$locale==='en'?'Read-only by design':'唯讀設計'}</span></header>
 {#if $centerError}<Notice error text={$centerError}/>{/if}
 <Notice text={$locale==='en'?'Only literal loopback endpoints are accepted. Credentials stay in native memory until the app exits; they are not saved with workspace data.':'只接受明確的本機回環位址。憑證保存在原生記憶體，程式退出後釋放，不會寫入工作區資料。'}/>
 <div class="cc-connections-grid"><ConnectionCard provider="paseo"/><ConnectionCard provider="anneal"/></div>
 <section class="cc-panel cc-mcp-connections"><header class="cc-section-header"><div><h2>{$locale==='en'?'ChatGPT & MCP':'ChatGPT 及 MCP'}</h2><p>{$locale==='en'?'Each workspace owns its service, tunnel, authentication and computer permissions.':'每個工作區分別管理服務、隧道、認證及電腦操作權限。'}</p></div><Cable size={22}/></header>{#if !$workspaces.length}<p class="cc-muted">{$locale==='en'?'Add a workspace to configure a ChatGPT MCP connection.':'新增工作區以設定 ChatGPT MCP 連線。'}</p>{:else}<div class="cc-workspace-connections">{#each $workspaces as w}<a href={'/workspace/'+w.id}><span><strong>{w.name}</strong><small>{w.auth?.type??'Authentication not configured'}</small></span><span>{$locale==='en'?'Configure MCP':'設定 MCP'}<ArrowUpRight size={15}/></span></a>{/each}</div>{/if}</section>
 <footer class="cc-page-footer">{$locale==='en'?'Adapters target pinned Paseo and Anneal protocols. This does not embed their autonomous runners, voice services or phone relay.':'整合使用已固定版本的 Paseo 及 Anneal 協定，不包含自主執行器、語音服務或手機中繼。'}</footer>
</section>
