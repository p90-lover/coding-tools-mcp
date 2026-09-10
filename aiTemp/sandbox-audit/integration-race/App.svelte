<script>
  import { snapshots, integrationBusy, readIntegration, clearIntegration } from '$lib/control-center/state';
  const source='paseo';
</script>
<button id="read" onclick={() => void readIntegration(source,'ws://127.0.0.1:6767/ws','')}>Read</button>
<button id="clear" onclick={() => clearIntegration(source)}>Clear</button>
<p id="busy">{$integrationBusy[source] ? 'busy' : 'idle'}</p>
<pre id="snapshot">{JSON.stringify($snapshots[source] ?? null)}</pre>
