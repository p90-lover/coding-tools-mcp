<script lang="ts">
 import { page } from '$app/stores';
 import { goto } from '$app/navigation';
 import { onMount } from 'svelte';
 import type { Snippet } from 'svelte';
 import { LayoutDashboard, Columns3, Layers, Monitor, Cable, Plug, Plus, Search, Menu, X, ChevronRight, Settings2, ShieldCheck, Github, Command } from '@lucide/svelte';
 import ThemeToggle from './ThemeToggle.svelte';
 import { APP_VERSION } from '$lib/app-version';
 import { REPO_URL } from '$lib/app-links';
 import { openUrl } from '$lib/api/app-info';
 import { workspaces } from '$lib/stores/app';
 import { locale, changeLanguage, initializePreferences } from '$lib/control-center/state';
 import { translated } from '$lib/control-center/model';
 interface Props { children:Snippet; sidebar:Snippet; onAddWorkspace?:()=>void|Promise<void>; settingsNav?:Snippet }
 let { children,sidebar,onAddWorkspace,settingsNav }:Props=$props();
 let menu=$state(false),searchOpen=$state(false),query=$state(''),repoError=$state('');
 let searchInput=$state<HTMLInputElement>();
 const nav=[{path:'/',en:'Overview',zh:'總覽',icon:LayoutDashboard},{path:'/work',en:'Work board',zh:'任務看板',icon:Columns3},{path:'/tasks',en:'Task monitor',zh:'任務監察',icon:Monitor},{path:'/sessions',en:'Agent sessions',zh:'Agent 會話',icon:Layers},{path:'/computer',en:'Computer control',zh:'電腦操作',icon:Monitor},{path:'/connections',en:'Connections',zh:'連線',icon:Cable},{path:'/integrations',en:'Integrations',zh:'專案整合',icon:Plug}];
 let title=$derived(nav.find(n=>n.path===$page.url.pathname)?.[$locale==='en'?'en':'zh'] ?? ($page.url.pathname.startsWith('/settings')?translated($locale,'Settings','設定'):translated($locale,'Workspace','工作區')));
 let results=$derived([...nav.map(n=>({label:translated($locale,n.en,n.zh),path:n.path})),...$workspaces.map(w=>({label:w.name,path:`/workspace/${w.id}`}))].filter(n=>n.label.toLowerCase().includes(query.toLowerCase())).slice(0,12));
 function search(){searchOpen=true;query='';setTimeout(()=>searchInput?.focus(),0);}
 function navigate(path:string){searchOpen=false;menu=false;void goto(path);}
 function keydown(e:KeyboardEvent){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();search();}if(e.key==='Escape'){searchOpen=false;menu=false;}}
 onMount(initializePreferences);
 $effect(()=>{if(typeof document!=="undefined")document.documentElement.lang=$locale;});
</script>
<svelte:window onkeydown={keydown}/>
<div class="cc-app">
 {#if menu}<button class="cc-nav-backdrop" aria-label="Close navigation" onclick={()=>menu=false}></button>{/if}
 <aside class:expanded={menu} class="cc-nav">
  <a class="cc-brand" href="/" onclick={()=>menu=false}><span class="cc-brand-mark"><Command size={21}/></span><span>Coding Tools<small>CONTROL CENTER</small></span></a>
  <nav aria-label="Main navigation" class="cc-primary-nav">{#each nav as n}<a href={n.path} class:active={$page.url.pathname===n.path} aria-current={$page.url.pathname===n.path?'page':undefined} onclick={()=>menu=false}><n.icon size={18}/><span>{translated($locale,n.en,n.zh)}</span>{#if $page.url.pathname===n.path}<span class="cc-nav-current"></span>{/if}</a>{/each}</nav>
  <div class="cc-nav-section"><span>{translated($locale,'WORKSPACES','工作區')}</span>{#if onAddWorkspace}<button onclick={onAddWorkspace} aria-label={translated($locale,'Add workspace','新增工作區')}><Plus size={16}/></button>{/if}</div>
  <div class="cc-workspace-nav">{#if $workspaces.length}{@render sidebar()}{:else}<p class="cc-nav-empty">{translated($locale,'Add your first workspace to get started.','新增第一個工作區以開始使用。')}</p>{/if}</div>
  <div class="cc-nav-bottom">{#if settingsNav}<details><summary><Settings2 size={17}/>{translated($locale,'Settings','設定')}<ChevronRight size={15}/></summary><div class="cc-settings-items">{@render settingsNav()}</div></details>{/if}
   <div class="cc-safe-mode"><ShieldCheck size={17}/><div>{translated($locale,'Local tools only','僅本機工具')}<small>{translated($locale,'No provider-agent launch','不啟動供應商 Agent')}</small></div></div>
   <div class="cc-version"><span>v{APP_VERSION}</span><button aria-label="Open GitHub repository" onclick={async()=>{try{await openUrl(REPO_URL);}catch{repoError='Open the repository from your browser. / 請在瀏覽器開啟儲存庫。';}}}><Github size={16}/></button></div>{#if repoError}<small>{repoError}</small>{/if}
  </div>
 </aside>
 <div class="cc-main">
  <header class="cc-topbar"><div class="cc-breadcrumb"><button class="cc-mobile-menu cc-icon-btn" onclick={()=>menu=!menu} aria-label="Open navigation"><Menu size={19}/></button><span class="cc-breadcrumb-root">{translated($locale,'Control center','控制中心')}</span><ChevronRight size={14}/><strong>{title}</strong></div><div class="cc-top-actions"><button class="cc-search-trigger" onclick={search}><Search size={16}/><span>{translated($locale,'Jump to…','快速跳至…')}</span><kbd>⌘ K</kbd></button><button class="cc-icon-btn cc-language" onclick={changeLanguage} aria-label="Change language">{$locale==='en'?'繁中':'EN'}</button><ThemeToggle/></div></header>
  <main class="cc-main-content">{@render children()}</main>
 </div>
</div>
{#if searchOpen}
 <div class="cc-palette-backdrop"><dialog open class="cc-palette" aria-modal="true" aria-label="Jump to page" tabindex="-1" onkeydown={(e)=>{if(e.key==='Tab'){const targets=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input,button,a[href]'));const first=targets[0],last=targets.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}}><div class="cc-palette-search"><Search size={20}/><input bind:this={searchInput} bind:value={query} placeholder={translated($locale,'Search pages and workspaces…','搜尋頁面及工作區…')} onkeydown={(e)=>{if(e.key==='Enter'&&results[0])navigate(results[0].path);}}/><button class="cc-icon-btn" onclick={()=>searchOpen=false} aria-label="Close search"><X size={18}/></button></div><div class="cc-palette-results">{#each results as result}<button onclick={()=>navigate(result.path)}><span>{result.label}</span><ChevronRight size={16}/></button>{/each}{#if !results.length}<p>{translated($locale,'No matching pages.','沒有相符頁面。')}</p>{/if}</div><footer>{translated($locale,'Enter opens the first result · Esc closes','Enter 開啟第一項 · Esc 關閉')}</footer></dialog></div>
{/if}
<svelte:head><title>Coding Tools · {title}</title></svelte:head>
