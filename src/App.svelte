<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Action } from 'svelte/action'
  import { fromAction } from 'svelte/attachments'
  import type { VibeComponent, VibeDocument, VibePagePlacement } from './studio/vibe-document.ts'
  import {
    createEmptyVibeDocument,
    documentToVibeContextJson,
  } from './studio/vibe-document.ts'
  import { loadVibeDocument, saveVibeDocument } from './studio/vibe-persistence.ts'
  import {
    buildVibePreviewSrcdoc,
    buildVibeSingleComponentPreviewSrcdoc,
    extractVibeTemplateTokens,
    pruneVibeComponentInputValues,
  } from './studio/vibe-preview-html.ts'
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
  import {
    createDefaultVibePlacementLayout,
    mergeVibePlacementLayoutPatch,
    sanitizeVibePlacementBackground,
    VIBE_PLACEMENT_LAYOUT_PRESETS,
    type VibePlacementAlign,
    type VibePlacementBorder,
    type VibePlacementLayout,
    type VibePlacementLayoutPresetId,
    type VibePlacementShadow,
    type VibePlacementWidthMode,
  } from './studio/vibe-placement-layout.ts'

  type AiChatRole = 'user' | 'assistant' | 'system'
  type AiChatMessage = {
    id: string
    role: AiChatRole
    text: string
    createdAt: number
  }

  let doc = $state<VibeDocument>(createEmptyVibeDocument())
  let docHydrated = $state(false)
  let workspaceMode = $state<'library' | 'page'>('library')
  let formName = $state('')
  let formHtml = $state('')
  let editingId = $state<string | null>(null)
  /** Library list selection: drives single-component iframe preview in Library tab. */
  let selectedLibraryComponentId = $state<string | null>(null)
  /** Placeholder values while composing a new component (not yet saved). */
  let formInputValues = $state<Record<string, string>>({})

  let aiEndpoint = $state('')
  let aiKey = $state('')
  let aiModel = $state('')
  let aiUserMessage = $state('')
  let aiChatMessages = $state<AiChatMessage[]>([])
  let aiBusy = $state(false)
  let collapsedPlacements = $state<Record<string, boolean>>({})
  let abortCtl: AbortController | null = null

  const aiThreadScrollAction: Action<HTMLDivElement, AiChatMessage[]> = (node, _messages) => {
    async function scrollToEnd(): Promise<void> {
      await tick()
      node.scrollTop = node.scrollHeight
    }
    void scrollToEnd()
    return { update: () => void scrollToEnd() }
  }

  function pushAiChatMessage(role: AiChatRole, text: string): void {
    aiChatMessages = [
      ...aiChatMessages,
      { id: newId(), role, text, createdAt: Date.now() },
    ]
  }

  const previewSrcdoc = $derived.by(() => {
    if (workspaceMode === 'page') {
      return buildVibePreviewSrcdoc(doc.pagePlacements, doc.components)
    }
    if (selectedLibraryComponentId) {
      const c = doc.components.find((x) => x.id === selectedLibraryComponentId)
      if (c) return buildVibeSingleComponentPreviewSrcdoc(c)
    }
    return buildVibePreviewSrcdoc(doc.pagePlacements, doc.components)
  })

  const previewChromeLabel = $derived.by(() => {
    if (workspaceMode === 'page') {
      return 'Page preview (placed components only)'
    }
    if (selectedLibraryComponentId) {
      const name = doc.components.find((x) => x.id === selectedLibraryComponentId)?.name
      return name ? `Component preview — ${name}` : 'Component preview'
    }
    return 'Page preview (select a library item to preview it alone)'
  })

  const templateTokensInForm = $derived(extractVibeTemplateTokens(formHtml))

  function componentNameForPlacement(p: VibePagePlacement): string {
    return doc.components.find((c) => c.id === p.componentId)?.name ?? 'Missing component'
  }

  function componentForPlacement(p: VibePagePlacement): VibeComponent | undefined {
    return doc.components.find((c) => c.id === p.componentId)
  }

  function placementTemplateTokens(p: VibePagePlacement): string[] {
    const html = componentForPlacement(p)?.html ?? ''
    return extractVibeTemplateTokens(html)
  }

  /** Effective value: placement override, else library default. */
  function placementFieldValue(p: VibePagePlacement, token: string): string {
    const comp = componentForPlacement(p)
    if (Object.prototype.hasOwnProperty.call(p.inputValues, token)) {
      return p.inputValues[token]!
    }
    return comp?.inputValues[token] ?? ''
  }

  function setPlacementInputValue(placementId: string, token: string, value: string): void {
    const idx = doc.pagePlacements.findIndex((p) => p.id === placementId)
    if (idx < 0) return
    const p = doc.pagePlacements[idx]!
    const comp = componentForPlacement(p)
    const html = comp?.html ?? ''
    const nextPlacements = [...doc.pagePlacements]
    nextPlacements[idx] = {
      ...p,
      inputValues: pruneVibeComponentInputValues(html, { ...p.inputValues, [token]: value }),
    }
    doc = { ...doc, pagePlacements: nextPlacements }
  }

  function addPlacement(componentId: string): void {
    doc = {
      ...doc,
      pagePlacements: [
        ...doc.pagePlacements,
        {
          id: newId(),
          componentId,
          inputValues: {},
          layout: createDefaultVibePlacementLayout(),
        },
      ],
    }
  }

  function updatePlacementLayout(placementId: string, patch: Partial<VibePlacementLayout>): void {
    const idx = doc.pagePlacements.findIndex((p) => p.id === placementId)
    if (idx < 0) return
    const p = doc.pagePlacements[idx]!
    const layout = mergeVibePlacementLayoutPatch(p.layout, patch)
    const nextPlacements = [...doc.pagePlacements]
    nextPlacements[idx] = { ...p, layout }
    doc = { ...doc, pagePlacements: nextPlacements }
  }

  function setPlacementLayoutPreset(
    placementId: string,
    presetId: VibePlacementLayoutPresetId
  ): void {
    const idx = doc.pagePlacements.findIndex((p) => p.id === placementId)
    if (idx < 0) return
    const p = doc.pagePlacements[idx]!
    const preset = VIBE_PLACEMENT_LAYOUT_PRESETS[presetId]
    const nextPlacements = [...doc.pagePlacements]
    nextPlacements[idx] = { ...p, layout: { ...preset } }
    doc = { ...doc, pagePlacements: nextPlacements }
  }

  function isPlacementCollapsed(placementId: string): boolean {
    return collapsedPlacements[placementId] ?? false
  }

  function togglePlacementCollapsed(placementId: string): void {
    collapsedPlacements = {
      ...collapsedPlacements,
      [placementId]: !isPlacementCollapsed(placementId),
    }
  }

  function removePlacement(placementId: string): void {
    const nextCollapsedPlacements = { ...collapsedPlacements }
    delete nextCollapsedPlacements[placementId]
    collapsedPlacements = nextCollapsedPlacements
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

  /** Sync draft placeholder keys with `{token}` names in HTML (new component only). */
  $effect(() => {
    if (editingId) return
    const tokens = extractVibeTemplateTokens(formHtml)
    const next: Record<string, string> = {}
    for (const t of tokens) {
      next[t] = formInputValues[t] ?? ''
    }
    const keysMatch =
      Object.keys(next).length === Object.keys(formInputValues).length &&
      Object.keys(next).every((k) => next[k] === formInputValues[k])
    if (!keysMatch) {
      formInputValues = next
    }
  })

  /** Drop stale placeholder keys when HTML tokens change (saved component in the form). */
  $effect(() => {
    if (!editingId) return
    const idx = doc.components.findIndex((c) => c.id === editingId)
    if (idx < 0) return
    const c = doc.components[idx]!
    const pruned = pruneVibeComponentInputValues(formHtml, c.inputValues)
    const same =
      Object.keys(pruned).length === Object.keys(c.inputValues).length &&
      Object.keys(pruned).every((k) => pruned[k] === c.inputValues[k])
    if (!same) {
      const nextComps = [...doc.components]
      nextComps[idx] = { ...c, inputValues: pruned }
      doc = { ...doc, components: nextComps }
    }
  })

  function resetForm(): void {
    formName = ''
    formHtml = ''
    editingId = null
    selectedLibraryComponentId = null
    formInputValues = {}
  }

  function selectLibraryComponent(c: VibeComponent): void {
    selectedLibraryComponentId = c.id
    editingId = c.id
    formName = c.name
    formHtml = c.html
  }

  function setComponentInputValue(componentId: string, token: string, value: string): void {
    const idx = doc.components.findIndex((c) => c.id === componentId)
    if (idx < 0) return
    const c = doc.components[idx]!
    const nextComps = [...doc.components]
    nextComps[idx] = { ...c, inputValues: { ...c.inputValues, [token]: value } }
    doc = { ...doc, components: nextComps }
  }

  function setFormInputValue(token: string, value: string): void {
    formInputValues = { ...formInputValues, [token]: value }
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
      const cur = doc.components[idx]!
      const next = [...doc.components]
      next[idx] = {
        ...cur,
        name,
        html: formHtml,
        inputValues: pruneVibeComponentInputValues(formHtml, cur.inputValues),
      }
      doc = {
        ...doc,
        components: next,
        pagePlacements: doc.pagePlacements.map((p) =>
          p.componentId === editingId
            ? { ...p, inputValues: pruneVibeComponentInputValues(formHtml, p.inputValues) }
            : p
        ),
      }
    } else {
      doc = {
        ...doc,
        components: [
          ...doc.components,
          {
            id: newId(),
            name,
            html: formHtml,
            inputValues: pruneVibeComponentInputValues(formHtml, formInputValues),
          },
        ],
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
    if (editingId === id || selectedLibraryComponentId === id) resetForm()
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
    pushAiChatMessage('user', msg)
    aiUserMessage = ''

    aiBusy = true
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
      if (reply.error === 'aborted') {
        pushAiChatMessage('system', 'Request cancelled.')
      } else {
        pushAiChatMessage('system', reply.error)
      }
      return
    }
    const parsed = parseVibePatchOpsFromLlmText(reply.content)
    if (!parsed.ok) {
      pushAiChatMessage('system', parsed.error)
      return
    }
    doc = applyVibePatchOps(doc, parsed.ops)
    pushAiChatMessage(
      'assistant',
      parsed.ops.length === 0
        ? 'No operations returned; document unchanged.'
        : `Applied ${parsed.ops.length} operation${parsed.ops.length === 1 ? '' : 's'}.`
    )
  }

  function cancelAi(): void {
    abortCtl?.abort()
  }
</script>

<div class="vibe-app">
  <header class="vibe-header">
    <div class="vibe-brand">
      <span class="vibe-logo">POP</span>
      <span class="vibe-tagline">
        Library + page builder — Page builder shows the composed page; Library can preview one component
      </span>
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
          Definitions live here only. Paste HTML (inline CSS or <code>&lt;style&gt;</code> is fine).           Use <code>{'{token}'}</code> for editable text (e.g.
          <code>&lt;h2&gt;{'{title}'}</code>&lt;/h2&gt;).
          Defaults here apply to new page instances; override each instance in <strong>Page builder</strong>.
          Click a saved component to preview with these defaults.
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
            placeholder='<div style="padding:1rem">...</div>'
            spellcheck={false}
          ></textarea>

          {#if templateTokensInForm.length > 0}
            <p class="vibe-label" style="margin-top: 0.5rem">Placeholder values</p>
            <p class="vibe-hint" style="margin: 0 0 0.35rem">
              Default text for <code>{'{name}'}</code> in the HTML (per-instance overrides in Page builder).
            </p>
            <div class="vibe-token-fields">
              {#each templateTokensInForm as token (token)}
                <div class="vibe-token-row">
                  <label class="vibe-label vibe-token-label" for="vibe-token-{token}">{`{${token}}`}</label>
                  <input
                    id="vibe-token-{token}"
                    class="vibe-input"
                    type="text"
                    value={editingId
                      ? (doc.components.find((c) => c.id === editingId)?.inputValues[token] ?? '')
                      : (formInputValues[token] ?? '')}
                    oninput={(e) => {
                      const v = e.currentTarget.value
                      if (editingId) setComponentInputValue(editingId, token, v)
                      else setFormInputValue(token, v)
                    }}
                    autocomplete="off"
                  />
                </div>
              {/each}
            </div>
          {/if}

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
              <li
                class="vibe-list-item"
                class:vibe-list-item--selected={selectedLibraryComponentId === c.id}
              >
                <button type="button" class="vibe-list-select" onclick={() => selectLibraryComponent(c)}>
                  <span class="vibe-list-name">{c.name}</span>
                </button>
                <div class="vibe-list-actions">
                  <button type="button" class="vibe-btn vibe-btn--small" onclick={() => selectLibraryComponent(c)}>
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
          Preview stacks placements in order. By default the wrapper adds <strong>no</strong> extra card—your
          library HTML sets the look. Use presets when you want a framed block (padding, surface, shadow).
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
              {@const placementTokens = placementTemplateTokens(p)}
              {@const placementCollapsed = isPlacementCollapsed(p.id)}
              <li class="vibe-page-item" class:vibe-page-item--collapsed={placementCollapsed}>
                <div class="vibe-page-item-main">
                  <span class="vibe-page-name">{componentNameForPlacement(p)}</span>
                  <div class="vibe-page-item-main-right">
                    <span class="vibe-page-id" title={p.id}>{p.id.slice(0, 8)}…</span>
                    <button
                      type="button"
                      class="vibe-collapse-toggle"
                      onclick={() => togglePlacementCollapsed(p.id)}
                      aria-label={placementCollapsed ? 'Expand placement inspector' : 'Collapse placement inspector'}
                      aria-expanded={!placementCollapsed}
                      title={placementCollapsed ? 'Expand details' : 'Collapse details'}
                    >
                      {placementCollapsed ? '▸' : '▾'}
                    </button>
                  </div>
                </div>

                {#if !placementCollapsed}
                  <div class="vibe-inspector-presets">
                    <span class="vibe-inspector-section" style="margin-top:0">Presets</span>
                    <div class="vibe-inspector-preset-btns">
                      <button
                        type="button"
                        class="vibe-btn vibe-btn--small"
                        title="No wrapper chrome—component HTML defines the surface"
                        onclick={() => setPlacementLayoutPreset(p.id, 'default')}
                      >
                        Plain
                      </button>
                      <button
                        type="button"
                        class="vibe-btn vibe-btn--small"
                        onclick={() => setPlacementLayoutPreset(p.id, 'hero')}
                      >
                        Hero
                      </button>
                      <button
                        type="button"
                        class="vibe-btn vibe-btn--small"
                        onclick={() => setPlacementLayoutPreset(p.id, 'card')}
                      >
                        Card
                      </button>
                      <button
                        type="button"
                        class="vibe-btn vibe-btn--small"
                        onclick={() => setPlacementLayoutPreset(p.id, 'section')}
                      >
                        Section
                      </button>
                      <button
                        type="button"
                        class="vibe-btn vibe-btn--small"
                        onclick={() => setPlacementLayoutPreset(p.id, 'ctaRow')}
                      >
                        CTA row
                      </button>
                    </div>
                  </div>
                  <p class="vibe-inspector-section">Layout</p>
                  <div class="vibe-inspector-grid">
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-wm">Width</label>
                    <select
                      id="vibe-pl-{p.id}-wm"
                      class="vibe-select"
                      value={p.layout.widthMode}
                      onchange={(e) =>
                        updatePlacementLayout(p.id, {
                          widthMode: e.currentTarget.value as VibePlacementWidthMode,
                        })}
                    >
                      <option value="fill">Fill (100%)</option>
                      <option value="fixed">Fixed (px)</option>
                      <option value="content">Hug content</option>
                    </select>

                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-al">Align</label>
                    <select
                      id="vibe-pl-{p.id}-al"
                      class="vibe-select"
                      value={p.layout.align}
                      onchange={(e) =>
                        updatePlacementLayout(p.id, {
                          align: e.currentTarget.value as VibePlacementAlign,
                        })}
                    >
                      <option value="stretch">Stretch</option>
                      <option value="start">Start</option>
                      <option value="center">Center</option>
                      <option value="end">End</option>
                    </select>
                  </div>
                  {#if p.layout.widthMode === 'fill'}
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-mw"
                      >Max width (px, 0 = none)</label
                    >
                    <input
                      id="vibe-pl-{p.id}-mw"
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="2400"
                      value={p.layout.maxWidthPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          maxWidthPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                  {:else if p.layout.widthMode === 'fixed'}
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-wp">Width (px)</label>
                    <input
                      id="vibe-pl-{p.id}-wp"
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="80"
                      max="2000"
                      value={p.layout.widthPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          widthPx: Number(e.currentTarget.value) || 80,
                        })}
                    />
                  {/if}
                  <div class="vibe-inspector-grid" style="margin-top: 0.35rem">
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-mt">Margin T</label>
                    <input
                      id="vibe-pl-{p.id}-mt"
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="200"
                      value={p.layout.marginTopPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          marginTopPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-mb">Margin B</label>
                    <input
                      id="vibe-pl-{p.id}-mb"
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="200"
                      value={p.layout.marginBottomPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          marginBottomPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                  </div>

                  <p class="vibe-inspector-section">Style</p>
                  <p class="vibe-inspector-label-sm" style="margin: 0 0 0.25rem">Padding (px)</p>
                  <div class="vibe-inspector-grid vibe-inspector-grid--pads">
                    <input
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="200"
                      title="Top"
                      aria-label="Padding top"
                      value={p.layout.paddingTopPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          paddingTopPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                    <input
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="200"
                      title="Right"
                      aria-label="Padding right"
                      value={p.layout.paddingRightPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          paddingRightPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                    <input
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="200"
                      title="Bottom"
                      aria-label="Padding bottom"
                      value={p.layout.paddingBottomPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          paddingBottomPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                    <input
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="200"
                      title="Left"
                      aria-label="Padding left"
                      value={p.layout.paddingLeftPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          paddingLeftPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                  </div>
                  <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-bg">Background</label>
                  <input
                    id="vibe-pl-{p.id}-bg"
                    class="vibe-input vibe-input--mono"
                    type="text"
                    value={p.layout.background}
                    onchange={(e) =>
                      updatePlacementLayout(p.id, {
                        background: sanitizeVibePlacementBackground(e.currentTarget.value),
                      })}
                    autocomplete="off"
                    placeholder="transparent, #fff, rgba(...)"
                  />
                  <div class="vibe-inspector-grid" style="margin-top: 0.35rem">
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-br">Radius</label>
                    <input
                      id="vibe-pl-{p.id}-br"
                      class="vibe-input vibe-input--inspector-num"
                      type="number"
                      min="0"
                      max="64"
                      value={p.layout.borderRadiusPx}
                      oninput={(e) =>
                        updatePlacementLayout(p.id, {
                          borderRadiusPx: Number(e.currentTarget.value) || 0,
                        })}
                    />
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-sh">Shadow</label>
                    <select
                      id="vibe-pl-{p.id}-sh"
                      class="vibe-select"
                      value={p.layout.shadow}
                      onchange={(e) =>
                        updatePlacementLayout(p.id, {
                          shadow: e.currentTarget.value as VibePlacementShadow,
                        })}
                    >
                      <option value="none">None</option>
                      <option value="sm">Small</option>
                      <option value="md">Medium</option>
                    </select>
                    <label class="vibe-label vibe-inspector-label-sm" for="vibe-pl-{p.id}-bd">Border</label>
                    <select
                      id="vibe-pl-{p.id}-bd"
                      class="vibe-select"
                      value={p.layout.border}
                      onchange={(e) =>
                        updatePlacementLayout(p.id, {
                          border: e.currentTarget.value as VibePlacementBorder,
                        })}
                    >
                      <option value="none">None</option>
                      <option value="subtle">Subtle</option>
                      <option value="strong">Strong</option>
                    </select>
                  </div>

                  {#if placementTokens.length > 0}
                    <p class="vibe-inspector-section">Content</p>
                    <div class="vibe-page-tokens">
                      {#each placementTokens as token (token)}
                        <div class="vibe-token-row vibe-token-row--inspector">
                          <label class="vibe-label vibe-token-label" for="vibe-pl-{p.id}-{token}"
                            >{`{${token}}`}</label
                          >
                          <input
                            id="vibe-pl-{p.id}-{token}"
                            class="vibe-input"
                            type="text"
                            value={placementFieldValue(p, token)}
                            oninput={(e) =>
                              setPlacementInputValue(p.id, token, e.currentTarget.value)}
                            autocomplete="off"
                          />
                        </div>
                      {/each}
                    </div>
                  {/if}
                {/if}
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
        <span class="vibe-preview-label">{previewChromeLabel}</span>
      </div>
      <iframe
        class="vibe-preview-frame"
        title="POP vibe preview"
        sandbox="allow-scripts allow-same-origin"
        srcdoc={previewSrcdoc}
      ></iframe>
    </main>

    <aside class="vibe-panel vibe-panel--right vibe-panel--assistant" aria-label="Design assistant">
      <h2 class="vibe-panel-title">Design assistant</h2>
      <p class="vibe-hint">
        Context includes the library and <code>pagePlacements</code>. The model returns JSON ops for library
        edits and for add/remove/reorder on the page.
      </p>

      <div class="vibe-ai-settings">
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
      </div>

      <div class="vibe-ai-chat">
        <div
          class="vibe-ai-thread"
          {@attach fromAction(aiThreadScrollAction, () => aiChatMessages)}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
        >
          {#if aiChatMessages.length === 0}
            <div class="vibe-ai-empty">
              <p class="vibe-ai-empty-title">Ask for layout or copy changes</p>
              <p class="vibe-ai-empty-body">
                Describe what you want in plain language. Each send includes the current document as context;
                successful replies apply patch operations to your library and page.
              </p>
            </div>
          {:else}
            {#each aiChatMessages as m (m.id)}
              <div
                class="vibe-ai-bubble"
                class:vibe-ai-bubble--user={m.role === 'user'}
                class:vibe-ai-bubble--assistant={m.role === 'assistant'}
                class:vibe-ai-bubble--system={m.role === 'system'}
              >
                <span class="vibe-ai-bubble-role">{m.role}</span>
                <div class="vibe-ai-bubble-text">{m.text}</div>
              </div>
            {/each}
          {/if}
        </div>

        <div class="vibe-ai-composer">
          <label class="vibe-label vibe-ai-composer-label" for="vibe-ai-msg">Message</label>
          <textarea
            id="vibe-ai-msg"
            class="vibe-textarea vibe-ai-composer-input"
            bind:value={aiUserMessage}
            rows="3"
            placeholder="e.g. Add a footer component with copyright text"
            disabled={aiBusy}
          ></textarea>
          <div class="vibe-ai-composer-actions">
            <button
              type="button"
              class="vibe-btn vibe-btn--primary"
              disabled={aiBusy || !aiUserMessage.trim()}
              onclick={() => void sendAi()}
            >
              {aiBusy ? 'Sending…' : 'Send'}
            </button>
            {#if aiBusy}
              <button type="button" class="vibe-btn vibe-btn--ghost" onclick={() => cancelAi()}>
                Cancel
              </button>
            {/if}
          </div>
        </div>
      </div>
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

  .vibe-panel--assistant {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    gap: 0;
  }

  .vibe-panel--assistant > .vibe-panel-title {
    flex-shrink: 0;
  }

  .vibe-panel--assistant > .vibe-hint {
    flex-shrink: 0;
    margin-bottom: 0.75rem;
  }

  .vibe-ai-settings {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
    margin-bottom: 0.75rem;
  }

  .vibe-ai-chat {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .vibe-ai-thread {
    flex: 1;
    min-height: 120px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.15rem 0.1rem 0.35rem;
    scrollbar-gutter: stable;
  }

  .vibe-ai-empty {
    margin: auto 0;
    padding: 1rem 0.5rem;
    text-align: center;
  }

  .vibe-ai-empty-title {
    margin: 0 0 0.4rem;
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--text);
  }

  .vibe-ai-empty-body {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.45;
    color: var(--muted);
  }

  .vibe-ai-bubble {
    max-width: 92%;
    padding: 0.45rem 0.6rem;
    border-radius: 12px;
    border: 1px solid var(--border);
    background: var(--surface-2);
  }

  .vibe-ai-bubble-role {
    display: block;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin-bottom: 0.2rem;
  }

  .vibe-ai-bubble-text {
    font-size: 0.84rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .vibe-ai-bubble--user {
    align-self: flex-end;
    margin-left: 1.5rem;
    border-color: rgba(196, 181, 253, 0.35);
    background: linear-gradient(180deg, rgba(196, 181, 253, 0.18), rgba(196, 181, 253, 0.06));
  }

  .vibe-ai-bubble--user .vibe-ai-bubble-role {
    text-align: right;
    color: rgba(196, 181, 253, 0.85);
  }

  .vibe-ai-bubble--assistant {
    align-self: flex-start;
    margin-right: 1.5rem;
  }

  .vibe-ai-bubble--system {
    align-self: stretch;
    max-width: none;
    text-align: center;
    border-style: dashed;
    border-color: rgba(251, 113, 133, 0.35);
    background: rgba(251, 113, 133, 0.06);
  }

  .vibe-ai-bubble--system .vibe-ai-bubble-role {
    color: var(--danger);
  }

  .vibe-ai-bubble--system .vibe-ai-bubble-text {
    color: var(--danger);
    font-size: 0.82rem;
  }

  .vibe-ai-composer {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-top: 0.25rem;
    border-top: 1px solid var(--border);
  }

  .vibe-ai-composer-label {
    margin-top: 0;
  }

  .vibe-ai-composer-input {
    min-height: 4.5rem;
    resize: vertical;
  }

  .vibe-ai-composer-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
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

  .vibe-list-item--selected {
    box-shadow: 0 0 0 1px rgba(196, 181, 253, 0.45);
    border-color: rgba(196, 181, 253, 0.4);
  }

  .vibe-list-select {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    border: none;
    padding: 0;
    margin: 0;
    background: transparent;
    font: inherit;
    font-weight: 600;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .vibe-list-select:hover .vibe-list-name {
    color: var(--accent);
  }

  .vibe-token-fields {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .vibe-token-row {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .vibe-token-label {
    font-family: var(--mono);
    margin-top: 0;
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

  .vibe-page-item-main-right {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .vibe-page-item--collapsed {
    gap: 0.35rem;
  }

  .vibe-collapse-toggle {
    width: 1.35rem;
    height: 1.35rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0;
    font: inherit;
    line-height: 1;
    cursor: pointer;
    color: var(--muted);
    background: var(--surface);
  }

  .vibe-collapse-toggle:hover {
    color: var(--text);
    border-color: rgba(196, 181, 253, 0.45);
  }

  .vibe-page-tokens {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding: 0.35rem 0 0;
    border-top: 1px solid var(--border);
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

  .vibe-inspector-section {
    font-size: 0.78rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0.5rem 0 0.25rem;
    font-weight: 600;
  }

  .vibe-inspector-grid {
    display: grid;
    grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
    gap: 0.4rem 0.5rem;
    align-items: center;
  }

  .vibe-inspector-grid--pads {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin-bottom: 0.35rem;
  }

  .vibe-inspector-label-sm {
    font-size: 0.72rem;
    color: var(--muted);
  }

  .vibe-inspector-presets {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding-bottom: 0.45rem;
    border-bottom: 1px solid var(--border);
  }

  .vibe-inspector-preset-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }

  .vibe-input--inspector-num {
    width: 100%;
    min-width: 0;
    padding: 0.25rem 0.4rem;
    font-size: 0.85rem;
  }

  .vibe-token-row--inspector {
    flex-direction: column;
    gap: 0.2rem;
  }

</style>
