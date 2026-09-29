"""Wire read-only inspectors into existing source directories; retain originals."""
from pathlib import Path
import os,shutil,subprocess
for name,source in [('src/routes/sessions/+page.svelte','paseo'),('src/routes/work/+page.svelte','anneal')]:
    path=Path(name);text=path.read_text(encoding='utf-8')
    if 'SourceDetail from' in text:continue
    anchor="import Status from '$lib/components/control-center/Status.svelte';"
    assert text.count(anchor)==1
    text=text.replace(anchor,anchor+"\n import SourceDetail from '$lib/components/control-center/SourceDetail.svelte';\n let inspectedSource=$state(''),inspectedEndpoint=$state('');\n let sourceDetail=$derived($snapshots."+source+"?.endpoint===inspectedEndpoint?$snapshots."+source+"?.items.find(i=>i.id===inspectedSource):undefined);",1)
    if source=='paseo':
        old="<strong>{row.title||t($locale,'Untitled session','未命名會話')}</strong>"
        new="<button class=\"cc-button ghost\" aria-label={t($locale,`Inspect session ${row.title||row.id}`,`檢視會話 ${row.title||row.id}`)} onclick={()=>{inspectedSource=row.id;inspectedEndpoint=$snapshots.paseo?.endpoint??'';}}>{row.title||t($locale,'Untitled session','未命名會話')}</button>"
    else:
        old='<strong>{row.title || row.id}</strong>'
        new="<button class=\"cc-button ghost\" aria-label={t($locale,`Inspect Anneal task ${row.title||row.id}`,`檢視 Anneal 任務 ${row.title||row.id}`)} onclick={()=>{inspectedSource=row.id;inspectedEndpoint=$snapshots.anneal?.endpoint??'';}}>{row.title || row.id}</button>"
    assert text.count(old)==1;text=text.replace(old,new,1)
    end=text.rfind('</section>');assert end>0
    condition="sourceDetail && $snapshots."+source+(" && source==='anneal'" if source=='anneal' else '')
    view='{#if '+condition+'}<SourceDetail item={sourceDetail} snapshot={$snapshots.'+source+'} source="'+source+'" onclose={()=>inspectedSource=\'\'}/>{/if}\n'
    text=text[:end]+view+text[end:]
    before=Path('aiTemp/Trash/source-details-before')/os.environ['GITHUB_RUN_ID']/name
    before.parent.mkdir(parents=True,exist_ok=True);assert not before.exists();shutil.copy2(path,before)
    path.write_text(text,encoding='utf-8');subprocess.run(['git','add','--',name],check=True)
print('SOURCE_DETAILS: source/endpoint-bound inspectors connected; no agent start, approval or mutation added')
