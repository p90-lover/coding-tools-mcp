<script lang="ts">
  import { Moon, Sun } from "@lucide/svelte";
  import { onMount } from "svelte";

  let dark = $state(true);

  onMount(() => {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") {
      dark = stored === "dark";
    } else {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    apply();
  });

  function apply() {
    const theme = dark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("theme", theme);
  }

  function toggle() {
    dark = !dark;
    apply();
  }
</script>

<button
  type="button"
  class="cc-icon-btn"
  onclick={toggle}
  aria-label={dark ? "Use light theme / 使用淺色主題" : "Use dark theme / 使用深色主題"}
>
  {#if dark}
    <Sun size={16} />
  {:else}
    <Moon size={16} />
  {/if}
</button>
