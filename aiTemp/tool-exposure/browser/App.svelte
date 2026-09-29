<script>
  import ToolCatalogStatus from '../../../src/lib/components/ToolCatalogStatus.svelte';
  import RuntimePolicyForm from '../../../src/lib/components/RuntimePolicyForm.svelte';
  let profile = $state('core');
  let saved = $state(null);
  const props = {permissionMode:'read-only',approvalMode:'ask',allowedCommands:'git',workspaceLocalEntries:false,workspaceScriptExtensions:'.exe',allowScreenCapture:false};
</script>
<h1>Tool exposure regression</h1>
<button onclick={() => {profile='core';saved=null;}}>Load core</button>
<button onclick={() => {profile='advanced';saved=null;}}>Load advanced</button>
<button onclick={() => {profile='full';saved=null;}}>Load full alias</button>
<RuntimePolicyForm toolProfile={profile} {...props} onSave={value => {saved=value;profile=value.toolProfile;}} />
<pre data-testid="saved">{JSON.stringify(saved)}</pre>

<ToolCatalogStatus workspaceId="fixture-workspace" {profile} />
