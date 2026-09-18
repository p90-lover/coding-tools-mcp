<script lang="ts">
  let { src, title }: { src: string; title: string } = $props();
  let failed = $state(false);
</script>

  {#if src && !failed}
  <iframe class="cc-original-frame" {title} src={src} referrerpolicy="no-referrer" onerror={() => (failed = true)}></iframe>
{:else if src}
  <p class="cc-help">Original UI did not load. Check the loopback web address.</p>
{/if}

<style>
  .cc-original-frame {
    width: 100%;
    min-height: 28rem;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--page-bg);
  }
</style>
