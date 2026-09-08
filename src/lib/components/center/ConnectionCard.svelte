<script lang="ts">
 import {onMount} from 'svelte';
 import {Plug,RefreshCw,ShieldCheck,ExternalLink,CheckCircle2,Unplug} from '@lucide/svelte';
 import {center,external,externalErrors,saveConnection,syncProvider,type Provider} from '$lib/control-center/api';
 import {locale} from '$lib/control-center/locale';
 import {formatTime} from '$lib/control-center/model.js';
 import {openUrl} from '$lib/api/app-info';
 import Notice from './Notice.svelte';
 let {provider}:{provider:Provider}=$props();
 let url=$state(''),token=$state(''),clearToken=$state(false),busy=$state(false),error=$state(''),success=$state('');
 let name=$derived(provider==='paseo'?'Paseo':'Anneal');
 let connection=$derived($center?.data[provider]);
 let hasToken=$derived(provider==='paseo'?$center?.paseo_has_token:$center?.anneal_has_token);
 let initialized=false;
 $effect(()=>{if(connection&&!initialized){url=connection.url;initialized=true;}});
 async function connect(){busy=true;error='';success='';const value=token;token='';try{await saveConnection(provider,url.trim(),true,value,clearToken);clearToken=false;await syncProvider(provider);success=$locale==='en'?'Connected and read successfully. No agent was started.':'已連接並成功讀取，沒有啟動 Agent。';}catch(e){error=String(e);}finally{busy=false;}}
 async function disconnect(){busy=true;error='';try{await saveConnection(provider,connection?.url??url,false,'',true);token='';success=$locale==='en'?'Observer disconnected. The upstream service is unchanged.':'觀察連線已中斷，上游服務未被變更。';}catch(e){error=String(e);}finally{busy=false;}}
 async function source(){try{await openUrl(provider==='paseo'?'https://github.com/getpaseo/paseo':'https://github.com/mosonlab/anneal');}catch(e){error=String(e);}}
</script>
<section class="cc-panel cc-connection-card">
 <header class="cc-connection-heading"><span class="cc-provider-symbol cc-provider-large">{provider==='paseo'?'P':'A'}</span><div><h2>{name}</h2><p>{provider==='paseo'?($locale==='en'?'Agent sessions, without agent execution.':'只觀察 Agent 會話，不執行 Agent。'):($locale==='en'?'Task boards and chain status, in one place.':'在同一介面查看任務看板與流程狀態。')}</p></div><button class="cc-icon-button" aria-label={`Open ${name} source repository`} onclick={source}><ExternalLink size={17}/></button></header>
 <div class="cc-connection-state"><span class="cc-state" data-state={connection?.enabled?'configured':'stopped'}>{connection?.enabled?($locale==='en'?'Observer configured':'觀察連線已設定'):($locale==='en'?'Not connected':'未連接')}</span><span class="cc-muted">{$external[provider]?`${$locale==='en'?'Last read':'最近讀取'} ${formatTime($external[provider]?.observed_at)}`:($locale==='en'?'Not verified yet':'尚未驗證')}</span></div>
 <form onsubmit={(e)=>{e.preventDefault();void connect();}}>
  <label class="cc-field">{$locale==='en'?'Local endpoint':'本機端點'}<input class="cc-input cc-mono" bind:value={url} required spellcheck="false" placeholder={provider==='paseo'?'ws://127.0.0.1:6767/ws':'http://127.0.0.1:5173/api'}/></label>
  <label class="cc-field">{provider==='paseo'?($locale==='en'?'Session password':'會話密碼'):($locale==='en'?'API token':'API Token')} <span class="cc-muted">{$locale==='en'?'Optional · memory only':'選填・只存於記憶體'}</span><input class="cc-input" type="password" autocomplete="off" bind:value={token} maxlength="1024" placeholder={hasToken?($locale==='en'?'A credential is held for this app session':'本次程式會話已保存憑證'):($locale==='en'?'Enter only if your local service requires it':'僅在本機服務要求時填寫')}/></label>
  {#if hasToken}<label class="cc-check"><input type="checkbox" bind:checked={clearToken}/>{$locale==='en'?'Clear the held credential when saving':'儲存時清除現有憑證'}</label>{/if}
  <p class="cc-muted">{provider==='paseo'?($locale==='en'?'Connects to an already-running daemon via its read-only directory protocol.':'透過目錄唯讀協定連接已運行的服務。'):($locale==='en'?'Use the existing web /api proxy or direct API origin. Anneal’s runner is not installed or launched.':'使用既有網頁 /api 代理或直接 API 位址。不會安裝或啟動 Anneal 執行器。')}</p>
  {#if error}<Notice text={error} error/>{:else if success}<Notice text={success}/>{:else if $externalErrors[provider]}<Notice text={$externalErrors[provider]??''} error/>{/if}
  <footer class="cc-connection-actions"><button type="submit" class="cc-button cc-primary" disabled={busy}><Plug size={16}/>{busy?($locale==='en'?'Checking…':'檢查中…'):($locale==='en'?'Save & verify':'儲存及驗證')}</button><button type="button" class="cc-button" onclick={disconnect} disabled={busy||!connection?.enabled}><Unplug size={15}/>{$locale==='en'?'Disconnect':'中斷連線'}</button></footer>
 </form>
</section>
