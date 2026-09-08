<script lang="ts">
 import {Info,AlertCircle} from '@lucide/svelte';
 let {text,error=false}:{text:string;error?:boolean}=$props();
</script>
<div class:cc-notice-error={error} class="cc-notice" role={error?'alert':'status'}>{#if error}<AlertCircle size={17}/>{:else}<Info size={17}/>{/if}<span>{text}</span></div>
