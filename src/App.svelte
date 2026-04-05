<script lang="ts">
  import { onMount } from 'svelte'
  import { mount as mountStudio } from './svg-studio'

  let host = $state<HTMLDivElement | null>(null)

  onMount(() => {
    if (host) mountStudio(host)
  })
</script>

<div class="pop-app-host" bind:this={host}></div>

<style>
  .pop-app-host {
    min-height: 100vh;
  }
</style>
