<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { LayoutDashboard, Columns3, Radio, Monitor, Cable, Settings2, Search, Plus, Command, Menu, X, ShieldCheck, Github, ChevronRight } from '@lucide/svelte';
  import ThemeToggle from '$lib/components/ThemeToggle.svelte';
  import { APP_VERSION } from '$lib/app-version';
  import { REPO_URL } from '$lib/app-links';
  import { openUrl } from '$lib/api/app-info';
  import { workspaces } from '$lib/stores/app';
  import { locale, labels } from '$lib/control-center/locale';
  import { showToast } from '$lib/stores/toast';
  interface Props { children:Snippet; sidebar:Snippet; onAddWorkspace?:()=>void|Promise<void>; settingsNav?:Snippet; }
  let {children,sidebar,onAddWorkspace,settingsNav}:Props=$props();
  let mobile=$state(false), query=$state('');
  let searchDialog:HTMLDialogElement;
  let searchInput:HTMLInputElement;
  let t=$derived(labels[$locale]);
  let nav=$derived([
    {url:'/',label:t.overview,icon:LayoutDashboard}, {url:'/tasks',label:t.tasks,icon:Columns3},
    {url:'/sessions',label:t.sessions,icon:Radio}, {url:'/computer',label:t.computer,icon:Monitor},
    {url:'/integrations',label:t.connections,icon:Cable},
  ]);
  let results=$derived([...nav.map(n=>({url:n.url,label:n.label,kind:$locale==='en'?'Page':'頁面'})),
    ...$workspaces.map(w=>({url:`/workspace/${w.id}`,label:w.name,kind:t.workspaces}))]
    .filter(n=>n.label.toLowerCase().includes(query.toLowerCase())).slice(0,25));
  let current=$derived(nav.find(n=>n.url===$page.url.pathname)?.label ?? ($page.url.pathname.startsWith('/settings')?t.settings:t.workspaces));
  async function search(){query='';searchDialog.showModal();await tick();searchInput.focus();}
  async function navigate(url:string){searchDialog.close();mobile=false;await goto(url);}
  async function repo(){try{await openUrl(REPO_URL);}catch(e){showToast(String(e),{kind:'error'});}}
  $effect(()=>{if(typeof document!=='undefined')document.documentElement.lang=$locale==='en'?'en':'zh-Hant';});
  onMount(()=>{
    try {const saved=localStorage.getItem('control-center.locale');if(saved==='en'||saved==='zh')locale.set(saved);}catch{}
    const unsubscribe=locale.subscribe(value=>{try{localStorage.setItem('control-center.locale',value);}catch{}});
    const keys=(event:KeyboardEvent)=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();void search();}};
    window.addEventListener('keydown',keys);
    return ()=>{unsubscribe();window.removeEventListener('keydown',keys);};
  });
</script>

<div class="app-layout cc-shell">
  {#if mobile}<button class="cc-scrim" aria-label="Close navigation" onclick={()=>mobile=false}></button>{/if}
  <aside class:cc-mobile-open={mobile} class="tx-sidebar cc-rail">
    <a class="cc-brand" href="/" onclick={()=>mobile=false}><span class="cc-brand-mark"><Command size={23}/></span><span><strong>Coding Tools</strong><small>Control center</small></span></a>
    <nav class="cc-navigation" aria-label={$locale==='en'?'Main navigation':'主要導覽'}>
      {#each nav as item}
        <a class:cc-selected={$page.url.pathname===item.url} href={item.url} onclick={()=>mobile=false} aria-current={$page.url.pathname===item.url?'page':undefined}><item.icon size={18}/><span>{item.label}</span></a>
      {/each}
    </nav>
    <div class="cc-workspace-heading"><span>{t.workspaces}</span>{#if onAddWorkspace}<button class="cc-icon-button" aria-label={t.add} title={t.add} onclick={onAddWorkspace}><Plus size={17}/></button>{/if}</div>
    <div class="tx-sidebar-body cc-project-list">{@render sidebar()}{#if !$workspaces.length}<p class="cc-rail-empty">{$locale==='en'?'Your projects will appear here.':'你的專案會顯示在這裡。'}</p>{/if}</div>
    <footer class="cc-rail-footer">
      {#if settingsNav}<details open={$page.url.pathname.startsWith('/settings')}><summary><Settings2 size={17}/>{t.settings}<ChevronRight size={14}/></summary><div class="cc-settings-nav">{@render settingsNav()}</div></details>{/if}
      <div class="cc-rail-tools"><ThemeToggle/><button class="cc-locale" onclick={()=>locale.update(l=>l==='en'?'zh':'en')} aria-label="Switch interface language">{$locale==='en'?'繁體中文':'English'}</button><button class="cc-icon-button" onclick={repo} aria-label="GitHub repository"><Github size={17}/></button></div>
      <div class="cc-version"><span class="cc-status-dot"></span>{t.local}<span>v{APP_VERSION}</span></div>
    </footer>
  </aside>
  <main class="tx-main cc-main">
    <header class="cc-topbar">
      <button class="cc-icon-button cc-menu" aria-label="Open navigation" onclick={()=>mobile=!mobile}><Menu size={21}/></button>
      <span class="cc-breadcrumb">Control center <ChevronRight size={13}/><strong>{current}</strong></span>
      <button class="cc-search-button" onclick={search}><Search size={16}/><span>{t.search}</span><kbd>⌘ / Ctrl K</kbd></button>
      <span class="cc-top-privacy" title={$locale==='en'?'External agent execution is disabled.':'外部 Agent 執行已停用。'}><ShieldCheck size={15}/>{$locale==='en'?'Observe, not execute':'唯讀觀察'}</span>
    </header>
    {@render children()}
  </main>
</div>
<dialog class="cc-command-dialog" bind:this={searchDialog} aria-label={t.searchTitle}>
  <div class="cc-command-input"><Search size={20}/><input bind:this={searchInput} bind:value={query} placeholder={t.search} aria-label={t.searchTitle}/><button class="cc-icon-button" aria-label="Close search" onclick={()=>searchDialog.close()}><X size={18}/></button></div>
  <div class="cc-command-results">{#each results as item}<button onclick={()=>navigate(item.url)}><span>{item.label}</span><small>{item.kind}</small><ChevronRight size={16}/></button>{/each}{#if !results.length}<p>{$locale==='en'?'No matching page or workspace.':'沒有相符的頁面或工作區。'}</p>{/if}</div>
</dialog>
<svelte:head><title>Coding Tools · {current}</title></svelte:head>
