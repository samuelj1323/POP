<script lang="ts">
  import { onMount } from 'svelte'
  import type { VibeComponent, VibeDocument, VibePagePlacement } from './studio/vibe-document.ts'
  import {
    createEmptyVibeDocument,
    documentToVibeContextJson,
  } from './studio/vibe-document.ts'
  import { loadVibeDocument, saveVibeDocument } from './studio/vibe-persistence.ts'
  import { buildVibePreviewSrcdoc } from './studio/vibe-preview-html.ts'
  import { applyVibePatchOps } from './studio/vibe-patch.ts'
  import { newId } from './studio/id.ts'
  import {
    buildGeminiGenerateContentUrl,
    buildVibeDesignLlmSystemPrompt,
    defaultGeminiModelId,
    fetchDesignLlmReply,
    GOOGLE_AI_STUDIO_GEMINI_MODELS,
    parseVibePatchOpsFromLlmText,
    readAiSettingsFromStorage,
    writeAiEndpoint,
    writeAiKey,
    writeAiModel,
  } from './studio/llm-design.ts'

  let doc = $state<VibeDocument>(createEmptyVibeDocument())
  let docHydrated = $state(false)
  let workspaceMode = $state<'library' | 'page'>('library')
  let formName = $state('')
  let formHtml = $state('')
  let editingId = $state<string | null>(null)

  let aiEndpoint = $state('')
  let aiKey = $state('')
  let aiModel = $state('')
  let aiUserMessage = $state('')
  let aiStatus = $state('')
  let aiBusy = $state(false)
  let abortCtl: AbortController | null = null

  const previewSrcdoc = $derived(buildVibePreviewSrcdoc(doc.pagePlacements, doc.components))

  function componentNameForPlacement(p: VibePagePlacement): string {
    return doc.components.find((c) => c.id === p.componentId)?.name ?? 'Missing component'
  }

  function addPlacement(componentId: string): void {
    doc = {
      ...doc,
      pagePlacements: [...doc.pagePlacements, { id: newId(), componentId }],
    }
  }

  function removePlacement(placementId: string): void {
    doc = {
      ...doc,
      pagePlacements: doc.pagePlacements.filter((p) => p.id !== placementId),
    }
  }

  function movePlacement(placementId: string, delta: -1 | 1): void {
    const i = doc.pagePlacements.findIndex((p) => p.id === placementId)
    if (i < 0) return
    const j = i + delta
    if (j < 0 || j >= doc.pagePlacements.length) return
    const arr = [...doc.pagePlacements]
    ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
    doc = { ...doc, pagePlacements: arr }
  }

  function uniqueComponentName(
    name: string,
    components: readonly VibeComponent[],
    excludeId?: string | null
  ): string {
    const taken = new Set(
      components
        .filter((c) => c.id !== excludeId)
        .map((c) => c.name.trim().toLowerCase())
    )
    let base = name.trim() || 'Component'
    let candidate = base
    let i = 2
    while (taken.has(candidate.toLowerCase())) {
      candidate = `${base} (${i})`
      i += 1
    }
    return candidate
  }

  onMount(() => {
    doc = loadVibeDocument()
    docHydrated = true
    const s = readAiSettingsFromStorage()
    aiEndpoint = s.endpoint
    aiKey = s.apiKey || (import.meta.env.VITE_POP_AI_KEY as string | undefined) || ''
    aiModel =
      s.model ||
      (import.meta.env.VITE_POP_AI_MODEL as string | undefined) ||
      defaultGeminiModelId()
  })

  $effect(() => {
    if (!docHydrated) return
    saveVibeDocument(doc)
  })

  function resetForm(): void {
    formName = ''
    formHtml = ''
    editingId = null
  }

  function startEdit(c: VibeComponent): void {
    editingId = c.id
    formName = c.name
    formHtml = c.html
  }

  function submitComponent(): void {
    const nameRaw = formName.trim()
    const htmlRaw = formHtml.trim()
    if (!nameRaw || !htmlRaw) {
      return
    }
    const name = uniqueComponentName(nameRaw, doc.components, editingId)

    if (editingId) {
      const idx = doc.components.findIndex((c) => c.id === editingId)
      if (idx < 0) return
      const next = [...doc.components]
      next[idx] = { ...next[idx]!, name, html: formHtml }
      doc = { ...doc, components: next }
    } else {
      doc = {
        ...doc,
        components: [...doc.components, { id: newId(), name, html: formHtml }],
      }
    }
    resetForm()
  }

  function removeComponent(id: string): void {
    doc = {
      ...doc,
      components: doc.components.filter((c) => c.id !== id),
      pagePlacements: doc.pagePlacements.filter((p) => p.componentId !== id),
    }
    if (editingId === id) resetForm()
  }

  function resolveLlmEndpoint(): string {
    const ep = aiEndpoint.trim()
    if (ep) return ep
    const model = aiModel.trim() || defaultGeminiModelId()
    return buildGeminiGenerateContentUrl(model)
  }

  async function sendAi(): Promise<void> {
    const msg = aiUserMessage.trim()
    if (!msg || aiBusy) return
    aiBusy = true
    aiStatus = ''
    abortCtl?.abort()
    abortCtl = new AbortController()

    writeAiEndpoint(aiEndpoint)
    writeAiKey(aiKey)
    writeAiModel(aiModel)

    const endpoint = resolveLlmEndpoint()
    const systemPrompt = buildVibeDesignLlmSystemPrompt()
    const userContent = `Current vibe document (JSON):\n${documentToVibeContextJson(doc)}\n\nUser request:\n${msg}`

    const reply = await fetchDesignLlmReply({
      endpoint,
      apiKey: aiKey.trim() || undefined,
      model: aiModel.trim() || defaultGeminiModelId(),
      systemPrompt,
      userContent,
      signal: abortCtl.signal,
    })

    aiBusy = false
    abortCtl = null

    if (!reply.ok) {
      aiStatus = reply.error
      return
    }
    const parsed = parseVibePatchOpsFromLlmText(reply.content)
    if (!parsed.ok) {
      aiStatus = parsed.error
      return
    }
    doc = applyVibePatchOps(doc, parsed.ops)
    aiStatus = `Applied ${parsed.ops.length} operation(s).`
    aiUserMessage = ''
  }

  function cancelAi(): void {
    abortCtl?.abort()
  }
</script>

<div class="vibe-app">
  <header class="vibe-header">
    <div class="vibe-brand">
      <span class="vibe-logo">POP</span>
      <span class="vibe-tagline">Library + page builder — preview shows the page only</span>
    </div>
  </header>

  <div class="vibe-body">
    <aside class="vibe-panel vibe-panel--left" aria-label="Workspace">
      <div class="vibe-tabs" role="tablist" aria-label="Workspace mode">
        <button
          type="button"
          role="tab"
          class="vibe-tab"
          class:vibe-tab--active={workspaceMode === 'library'}
          aria-selected={workspaceMode === 'library'}
          onclick={() => (workspaceMode = 'library')}
        >
          Library
        </button>
        <button
          type="button"
          role="tab"
          class="vibe-tab"
          class:vibe-tab--active={workspaceMode === 'page'}
          aria-selected={workspaceMode === 'page'}
          onclick={() => (workspaceMode = 'page')}
        >
          Page builder
        </button>
      </div>

      {#if workspaceMode === 'library'}
        <h2 class="vibe-panel-title">Component library</h2>
        <p class="vibe-hint">
          Definitions live here only. Paste HTML (inline CSS or <code>&lt;style&gt;</code> is fine). Open
          <strong>Page builder</strong> to place items on the preview.
        </p>

        <form
          class="vibe-form"
          onsubmit={(e) => {
            e.preventDefault()
            submitComponent()
          }}
        >
          <label class="vibe-label" for="vibe-name">Name</label>
          <input
            id="vibe-name"
            class="vibe-input"
            type="text"
            bind:value={formName}
            placeholder="e.g. Hero, NavBar"
            autocomplete="off"
          />

          <label class="vibe-label" for="vibe-html">HTML</label>
          <textarea
            id="vibe-html"
            class="vibe-textarea"
            bind:value={formHtml}
            rows="12"
            placeholder={'<div style="padding:1rem">...</div>'}
            spellcheck="false"
          ></textarea>

          <div class="vibe-form-actions">
            <button type="submit" class="vibe-btn vibe-btn--primary">
              {editingId ? 'Update component' : 'Add to library'}
            </button>
            {#if editingId || formName || formHtml}
              <button type="button" class="vibe-btn vibe-btn--ghost" onclick={() => resetForm()}>
                Cancel
              </button>
            {/if}
          </div>
        </form>

        <h3 class="vibe-subtitle">Saved components</h3>
        {#if doc.components.length === 0}
          <p class="vibe-muted">No components yet.</p>
        {:else}
          <ul class="vibe-list">
            {#each doc.components as c (c.id)}
              <li class="vibe-list-item">
                <span class="vibe-list-name">{c.name}</span>
                <div class="vibe-list-actions">
                  <button type="button" class="vibe-btn vibe-btn--small" onclick={() => startEdit(c)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    class="vibe-btn vibe-btn--small vibe-btn--danger"
                    onclick={() => removeComponent(c.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <h2 class="vibe-panel-title">Page builder</h2>
        <p class="vibe-hint">
          The center preview shows this ordered stack only. You can place the same library component more
          than once.
        </p>

        <h3 class="vibe-subtitle">Add from library</h3>
        {#if doc.components.length === 0}
          <p class="vibe-muted">Create components in the Library tab first.</p>
        {:else}
          <ul class="vibe-list">
            {#each doc.components as c (c.id)}
              <li class="vibe-list-item">
                <span class="vibe-list-name">{c.name}</span>
                <button
                  type="button"
                  class="vibe-btn vibe-btn--small vibe-btn--primary"
                  onclick={() => addPlacement(c.id)}
                >
                  Add to page
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <h3 class="vibe-subtitle">On this page</h3>
        {#if doc.pagePlacements.length === 0}
          <p class="vibe-muted">Nothing placed yet.</p>
        {:else}
          <ul class="vibe-page-list">
            {#each doc.pagePlacements as p, idx (p.id)}
              <li class="vibe-page-item">
                <div class="vibe-page-item-main">
                  <span class="vibe-page-name">{componentNameForPlacement(p)}</span>
                  <span class="vibe-page-id" title={p.id}>{p.id.slice(0, 8)}…</span>
                </div>
                <div class="vibe-list-actions">
                  <button
                    type="button"
                    class="vibe-btn vibe-btn--small"
                    disabled={idx === 0}
                    onclick={() => movePlacement(p.id, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    class="vibe-btn vibe-btn--small"
                    disabled={idx >= doc.pagePlacements.length - 1}
                    onclick={() => movePlacement(p.id, 1)}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    class="vibe-btn vibe-btn--small vibe-btn--danger"
                    onclick={() => removePlacement(p.id)}
                  >
                    Remove
                  </button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
    </aside>

    <main class="vibe-preview-wrap" aria-label="Preview">
      <div class="vibe-preview-chrome">
        <span class="vibe-preview-label">Page preview (placed components only)</span>
      </div>
      <iframe
        class="vibe-preview-frame"
        title="POP vibe preview"
        sandbox="allow-scripts allow-same-origin"
        srcdoc={previewSrcdoc}
      ></iframe>
    </main>

    <aside class="vibe-panel vibe-panel--right" aria-label="Design assistant">
      <h2 class="vibe-panel-title">Design assistant</h2>
      <p class="vibe-hint">
        Context includes the library and <code>pagePlacements</code>. The model returns JSON ops for library
        edits and for add/remove/reorder on the page.
      </p>

      <label class="vibe-label" for="vibe-ai-endpoint">API endpoint (optional)</label>
      <input
        id="vibe-ai-endpoint"
        class="vibe-input vibe-input--mono"
        bind:value={aiEndpoint}
        placeholder="Leave blank for Gemini URL from model"
        autocomplete="off"
      />

      <label class="vibe-label" for="vibe-ai-key">API key</label>
      <input
        id="vibe-ai-key"
        class="vibe-input vibe-input--mono"
        type="password"
        bind:value={aiKey}
        placeholder="Gemini: AI Studio key"
        autocomplete="off"
      />

      <label class="vibe-label" for="vibe-ai-model">Model</label>
      <select id="vibe-ai-model" class="vibe-select" bind:value={aiModel}>
        {#each GOOGLE_AI_STUDIO_GEMINI_MODELS as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>

      <label class="vibe-label" for="vibe-ai-msg">Request</label>
      <textarea
        id="vibe-ai-msg"
        class="vibe-textarea"
        bind:value={aiUserMessage}
        rows="6"
        placeholder="e.g. Add a footer component with copyright text"
      ></textarea>

      <div class="vibe-form-actions">
        <button
          type="button"
          class="vibe-btn vibe-btn--primary"
          disabled={aiBusy}
          onclick={() => void sendAi()}
        >
          {aiBusy ? 'Sending…' : 'Send'}
        </button>
        {#if aiBusy}
          <button type="button" class="vibe-btn vibe-btn--ghost" onclick={() => cancelAi()}>Cancel</button>
        {/if}
      </div>
      {#if aiStatus}
        <p
          class="vibe-status"
          class:vibe-status--error={!aiStatus.startsWith('Applied')}
        >
          {aiStatus}
        </p>
      {/if}
    </aside>
  </div>
</div>

<style>
  .vibe-app {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .vibe-header {
    flex-shrink: 0;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(28, 22, 48, 0.65) 0%, rgba(10, 6, 18, 0.35) 100%);
  }

  .vibe-brand {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.5rem 1rem;
  }

  .vibe-logo {
    font-family: var(--display);
    font-weight: 800;
    font-size: 1.25rem;
    letter-spacing: 0.04em;
  }

  .vibe-tagline {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .vibe-body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(260px, 340px) 1fr minmax(260px, 340px);
    gap: 0;
  }

  @media (max-width: 1100px) {
    .vibe-body {
      grid-template-columns: 1fr;
      grid-template-rows: auto 50vh auto;
    }
  }

  .vibe-panel {
    padding: 1rem;
    overflow: auto;
    border-right: 1px solid var(--border);
    background: var(--surface);
  }

  .vibe-panel--right {
    border-right: none;
    border-left: 1px solid var(--border);
  }

  @media (max-width: 1100px) {
    .vibe-panel {
      border-right: none;
      border-left: none;
      border-bottom: 1px solid var(--border);
    }
    .vibe-panel--right {
      border-bottom: none;
    }
  }

  .vibe-tabs {
    display: flex;
    gap: 0.25rem;
    margin: -0.25rem 0 1rem;
    padding: 0.2rem;
    border-radius: 10px;
    background: var(--surface-2);
    border: 1px solid var(--border);
  }

  .vibe-tab {
    flex: 1;
    border: none;
    border-radius: 8px;
    padding: 0.4rem 0.5rem;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    color: var(--muted);
    background: transparent;
  }

  .vibe-tab--active {
    color: var(--text);
    background: rgba(196, 181, 253, 0.12);
    box-shadow: 0 0 0 1px rgba(196, 181, 253, 0.25);
  }

  .vibe-panel-title {
    margin: 0 0 0.5rem;
    font-family: var(--display);
    font-size: 1.05rem;
  }

  .vibe-subtitle {
    margin: 1.25rem 0 0.5rem;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }

  .vibe-hint {
    margin: 0 0 1rem;
    font-size: 0.85rem;
    color: var(--muted);
    line-height: 1.4;
  }

  .vibe-hint code {
    font-family: var(--mono);
    font-size: 0.8em;
    color: var(--accent);
  }

  .vibe-form {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .vibe-label {
    font-size: 0.8rem;
    color: var(--muted);
    margin-top: 0.25rem;
  }

  .vibe-input,
  .vibe-textarea,
  .vibe-select {
    width: 100%;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.45rem 0.55rem;
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
  }

  .vibe-input--mono,
  .vibe-textarea {
    font-family: var(--mono);
    font-size: 0.82rem;
  }

  .vibe-textarea {
    resize: vertical;
    min-height: 120px;
  }

  .vibe-form-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .vibe-btn {
    border-radius: 8px;
    border: 1px solid var(--border);
    padding: 0.45rem 0.85rem;
    font: inherit;
    cursor: pointer;
    background: var(--surface-2);
    color: var(--text);
  }

  .vibe-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .vibe-btn--primary {
    background: linear-gradient(180deg, rgba(196, 181, 253, 0.22), rgba(196, 181, 253, 0.08));
    border-color: rgba(196, 181, 253, 0.35);
  }

  .vibe-btn--ghost {
    background: transparent;
  }

  .vibe-btn--danger {
    border-color: rgba(251, 113, 133, 0.45);
    color: var(--danger);
  }

  .vibe-btn--small {
    padding: 0.25rem 0.5rem;
    font-size: 0.82rem;
  }

  .vibe-muted {
    color: var(--muted);
    font-size: 0.9rem;
  }

  .vibe-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .vibe-list-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.45rem 0.55rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
  }

  .vibe-list-name {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vibe-list-actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.35rem;
  }

  .vibe-page-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .vibe-page-item {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.5rem 0.55rem;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--surface-2);
  }

  .vibe-page-item-main {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.5rem;
    min-width: 0;
  }

  .vibe-page-name {
    font-weight: 600;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .vibe-page-id {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--muted);
    flex-shrink: 0;
  }

  .vibe-preview-wrap {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg);
  }

  .vibe-preview-chrome {
    flex-shrink: 0;
    padding: 0.4rem 0.75rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .vibe-preview-label {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }

  .vibe-preview-frame {
    flex: 1;
    min-height: 0;
    width: 100%;
    border: none;
    background: #fff;
  }

  .vibe-status {
    margin: 0.75rem 0 0;
    font-size: 0.85rem;
    color: var(--accent);
  }

  .vibe-status--error {
    color: var(--danger);
  }
</style>
