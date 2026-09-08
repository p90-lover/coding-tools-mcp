<script lang="ts">
 import { Monitor, ShieldCheck } from '@lucide/svelte';
 import { workspaces } from '$lib/stores/app';
 import { locale } from '$lib/control-center/state';
 import { translated as t } from '$lib/control-center/model';
 import ComputerControl from '$lib/components/ComputerControl.svelte';
 let selected=$state('');
 let current=$derived($workspaces.find(w=>w.id===selected)??$workspaces[0]);
</script>
<section class="cc-page"><header class="cc-page-heading"><div><h1>{t($locale,'Computer control','電腦操作')}</h1><p>{t($locale,'Observe approved windows. Stay present, keep control.','觀察已批准的視窗，保持可見並掌握控制權。')}</p></div><span class="cc-inline-label"><ShieldCheck size={16}/>{t($locale,'Memory-only vision','僅記憶體視覺')}</span></header>
 {#if current}<label class="cc-workspace-select">{t($locale,'Workspace','工作區')}<select value={current.id} onchange={e=>selected=e.currentTarget.value}>{#each $workspaces as w}<option value={w.id}>{w.name}</option>{/each}</select></label><div class="cc-control-surface">{#key current.id}<ComputerControl workspaceId={current.id}/>{/key}</div>{:else}<section class="cc-panel cc-empty tall"><Monitor size={33}/><h2>{t($locale,'Choose a workspace first','先選擇工作區')}</h2><p>{t($locale,'Add a local folder from the sidebar, then configure explicit application approval here.','從側邊欄新增本機資料夾，再於此設定明確的應用程式授權。')}</p></section>{/if}
 <div class="cc-note-panel"><h3>{t($locale,'Observation is not input','觀察不等於輸入')}</h3><p>{t($locale,'Background inspection does not bring approved windows forward. Mouse and keyboard input still requires the selected foreground target. Existing Always enabled, remembered approval and local Stop protections are unchanged.','背景觀察不會把已批准視窗切至前台；鍵鼠輸入仍需要指定視窗位於前台。持續啟用、記住授權及本機停止保障保持不變。')}</p></div>
</section>
