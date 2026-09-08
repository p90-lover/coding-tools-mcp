<script lang="ts">
 import { stateTone } from '$lib/control-center/model';
 let { state, label=state }: {state:string;label?:string}=$props();
</script>
<span class="cc-status {stateTone(state)}"><span></span>{label.replaceAll('_',' ')}</span>
