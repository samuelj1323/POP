import type { VibePatchOp } from './vibe-patch.ts'
import { parseVibePlacementLayoutPatchObject } from './vibe-placement-layout.ts'

const AI_STORAGE_ENDPOINT = 'pop-ai-endpoint'
const AI_STORAGE_KEY = 'pop-ai-key'
const AI_STORAGE_MODEL = 'pop-ai-model'

/** Google AI Studio `generateContent` base; model id is inserted before `:generateContent`. */
export const GEMINI_GENERATE_CONTENT_API_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models'

/** Models commonly available on the Gemini API free tier (text `generateContent`); ids match the API. */
export const GOOGLE_AI_STUDIO_GEMINI_MODELS: readonly { id: string; label: string }[] = [
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (preview)' },
] as const

export function buildGeminiGenerateContentUrl(modelId: string): string {
  const id = modelId.trim()
  return `${GEMINI_GENERATE_CONTENT_API_BASE}/${encodeURIComponent(id)}:generateContent`
}

export function defaultGeminiModelId(): string {
  return 'gemini-2.5-flash'
}

export function readAiSettingsFromStorage(): {
  endpoint: string
  apiKey: string
  model: string
} {
  try {
    return {
      endpoint: localStorage.getItem(AI_STORAGE_ENDPOINT) ?? '',
      apiKey: localStorage.getItem(AI_STORAGE_KEY) ?? '',
      model: localStorage.getItem(AI_STORAGE_MODEL) ?? '',
    }
  } catch {
    return { endpoint: '', apiKey: '', model: '' }
  }
}

export function writeAiEndpoint(url: string): void {
  try {
    if (url.trim()) localStorage.setItem(AI_STORAGE_ENDPOINT, url.trim())
    else localStorage.removeItem(AI_STORAGE_ENDPOINT)
  } catch {
    /* ignore */
  }
}

export function writeAiKey(key: string): void {
  try {
    if (key.trim()) localStorage.setItem(AI_STORAGE_KEY, key.trim())
    else localStorage.removeItem(AI_STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export function writeAiModel(model: string): void {
  try {
    if (model.trim()) localStorage.setItem(AI_STORAGE_MODEL, model.trim())
    else localStorage.removeItem(AI_STORAGE_MODEL)
  } catch {
    /* ignore */
  }
}

/** System prompt: library components + page placements; model returns patch ops JSON. */
export function buildVibeDesignLlmSystemPrompt(): string {
  return `You are a design assistant for POP, a browser-based vibe designing platform.

There are two layers:
1) **Library** — reusable components: each has an id, display name, HTML fragment (inline CSS or <style> blocks), and optional **inputValues** as default text for brace-wrapped token placeholders in the HTML (token names: letters, digits, underscore, hyphen).
2) **Page** — ordered list of **placements**. Each placement has its own id, references a library component via componentId, optional **inputValues** (per-instance overrides), and **layout** (see below). The iframe preview renders **only** these placements, top-to-bottom—not the whole library.

You output ONLY valid JSON: either a JSON array of patch operations, or a single object {"ops": [...]}.

Each operation is an object with an "op" field. Allowed ops:

**Library**
- {"op":"addComponent","component":{"name":string,"html":string,"id"?:string,"inputValues"?:object}} — adds a definition to the library (not automatically on the page). Optional id must be a new UUID if provided. Optional inputValues: map token name → string for brace placeholders in html.
- {"op":"updateComponent","id":string,"patch":{"name"?:string,"html"?:string,"inputValues"?:object}} — merge into an existing library component. inputValues updates defaults only; keys not in html are dropped. Existing placements have their overrides pruned to the new html tokens.
- {"op":"removeComponent","id":string} — removes from library and removes all page placements that reference that componentId.

**Page (preview)**
- {"op":"addPagePlacement","componentId":string,"placementId"?:string,"inputValues"?:object,"layout"?:object} — append one instance. Optional placementId (UUID) lets you add then reference the same id in later ops in one response; if omitted, id is generated and you cannot patch layout in the same turn unless you supplied placementId. Optional layout: full or partial layout object (same fields as in context); merged with POP defaults. Prefer setting layout here when adding so the page is not a boring vertical stack of identical blocks.
- {"op":"updatePagePlacement","id":string,"patch":{"inputValues"?:object,"layout"?:object}} — merge into one placement by id. layout: partial fields merged onto current layout. At least one of inputValues or layout must be present.
- {"op":"removePagePlacement","id":string} — remove one placement by its id (from pagePlacements in context).
- {"op":"movePagePlacement","id":string,"toIndex":number} — move the placement to a zero-based index in the current page list after removal (0 = top; use length to append).

**Placement layout (structure and intent)**

Each placement wraps the component HTML in an iframe slot. Default layout is a **pass-through** (transparent background, no border/shadow/padding) so the **component's own HTML** defines surface and typography. You should still vary **layout** across the page to create rhythm and hierarchy—do not rely on stacking identical full-width blocks only.

Layout fields (numbers are pixels unless noted):
- **widthMode**: "fill" | "fixed" | "content" — fill = 100% row width; fixed = widthPx; content = hug content (good for CTAs, badges, narrow cards).
- **widthPx** — used when widthMode is "fixed" (e.g. 480–720 for readable columns).
- **maxWidthPx** — when widthMode is "fill", caps width (e.g. 640–960 for prose); 0 means no cap.
- **align**: "stretch" | "start" | "center" | "end" — cross-axis in the vertical page (horizontal alignment of the block).
- **marginTopPx**, **marginBottomPx** — vertical rhythm between sections (e.g. 8–32 between blocks; more after heroes).
- **paddingTopPx**, **paddingRightPx**, **paddingBottomPx**, **paddingLeftPx** — outer "frame" around the fragment when you want a card or inset without bloating the component HTML.
- **background** — CSS color only: transparent, #rgb/#rrggbb, or rgba(...). Use for bands and cards.
- **borderRadiusPx** — corner rounding on the slot.
- **shadow**: "none" | "sm" | "md"
- **border**: "none" | "subtle" | "strong"

**Layout composition (do this, not only stacked HTML)**

- Treat the **page as a sequence of sections** with different roles: hero (wide, centered, generous padding/margins), content (maxWidth for reading), supporting rows (content width + center), CTAs (content width + center, pill radius).
- Use **widthMode + align + maxWidthPx** so blocks are not all full-bleed rectangles; center important content with align "center" and widthMode "content" or fill with maxWidthPx.
- Use **margins** for spacing between placements; avoid duplicating huge margin-top only inside every component's HTML when layout can own rhythm.
- Put **card chrome** (padding, white background, border, shadow) on **layout** when the component is structural (e.g. simple inner markup); keep **layout minimal** when the component already brings a complete styled surface.
- When adding multiple placements in one response, supply **placementId** UUIDs and include **layout** on each addPagePlacement so each block has intentional hierarchy without a second round trip.

**Minimal layout examples (patterns, not mandatory values)**

Opening hero band:
{"widthMode":"fill","maxWidthPx":720,"align":"center","marginTopPx":8,"marginBottomPx":28,"paddingTopPx":32,"paddingBottomPx":32,"paddingLeftPx":28,"paddingRightPx":28,"background":"#ffffff","borderRadiusPx":16,"shadow":"md","border":"none"}

Inset content section:
{"widthMode":"fill","maxWidthPx":960,"align":"stretch","marginBottomPx":20,"paddingTopPx":24,"paddingBottomPx":24,"paddingLeftPx":24,"paddingRightPx":24,"background":"rgba(255,255,255,0.72)","borderRadiusPx":12,"shadow":"none","border":"none"}

Centered CTA / button row:
{"widthMode":"content","align":"center","marginTopPx":4,"marginBottomPx":16,"paddingTopPx":10,"paddingBottomPx":10,"paddingLeftPx":16,"paddingRightPx":16,"background":"#ffffff","borderRadiusPx":999,"shadow":"sm","border":"subtle"}

Rules:
- Use exact "id" / "componentId" / placement "id" values from the user context JSON.
- Prefer small, safe edits. To change page order, use movePagePlacement.
- HTML fragments should be suitable inside a <section> wrapper (no <!DOCTYPE>).
- No markdown, no commentary outside the JSON.`
}

export function stripMarkdownJsonFence(s: string): string {
  let t = s.trim()
  if (t.startsWith('```')) {
    const nl = t.indexOf('\n')
    if (nl >= 0) t = t.slice(nl + 1)
    t = t.replace(/\n```\s*$/i, '').trim()
  }
  return t
}

function isVibePatchOp(x: unknown): x is VibePatchOp {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o.op !== 'string') return false
  switch (o.op) {
    case 'addComponent': {
      const c = o.component as Record<string, unknown> | undefined
      if (!c || typeof c !== 'object') return false
      if (typeof c.name !== 'string' || typeof c.html !== 'string') return false
      if (c.id !== undefined && typeof c.id !== 'string') return false
      if (c.inputValues !== undefined) {
        if (!c.inputValues || typeof c.inputValues !== 'object' || Array.isArray(c.inputValues)) return false
        for (const v of Object.values(c.inputValues as Record<string, unknown>)) {
          if (typeof v !== 'string') return false
        }
      }
      return true
    }
    case 'updateComponent': {
      if (typeof o.id !== 'string') return false
      const p = o.patch as Record<string, unknown> | undefined
      if (!p || typeof p !== 'object') return false
      if (p.name !== undefined && typeof p.name !== 'string') return false
      if (p.html !== undefined && typeof p.html !== 'string') return false
      if (p.inputValues !== undefined) {
        if (!p.inputValues || typeof p.inputValues !== 'object' || Array.isArray(p.inputValues)) return false
        for (const v of Object.values(p.inputValues as Record<string, unknown>)) {
          if (typeof v !== 'string') return false
        }
      }
      return true
    }
    case 'removeComponent':
      return typeof o.id === 'string'
    case 'addPagePlacement': {
      if (typeof o.componentId !== 'string') return false
      if (o.placementId !== undefined && typeof o.placementId !== 'string') return false
      if (o.inputValues !== undefined) {
        if (!o.inputValues || typeof o.inputValues !== 'object' || Array.isArray(o.inputValues)) return false
        for (const v of Object.values(o.inputValues as Record<string, unknown>)) {
          if (typeof v !== 'string') return false
        }
      }
      if (o.layout !== undefined) {
        if (!o.layout || typeof o.layout !== 'object' || Array.isArray(o.layout)) return false
      }
      return true
    }
    case 'updatePagePlacement': {
      if (typeof o.id !== 'string') return false
      const p = o.patch as Record<string, unknown> | undefined
      if (!p || typeof p !== 'object') return false
      const hasIv = p.inputValues !== undefined
      const hasLayout = p.layout !== undefined
      if (!hasIv && !hasLayout) return false
      if (hasIv) {
        if (!p.inputValues || typeof p.inputValues !== 'object' || Array.isArray(p.inputValues)) return false
        for (const v of Object.values(p.inputValues as Record<string, unknown>)) {
          if (typeof v !== 'string') return false
        }
      }
      if (hasLayout) {
        if (!p.layout || typeof p.layout !== 'object' || Array.isArray(p.layout)) return false
        if (parseVibePlacementLayoutPatchObject(p.layout) === null) return false
      }
      return true
    }
    case 'removePagePlacement':
      return typeof o.id === 'string'
    case 'movePagePlacement':
      return typeof o.id === 'string' && typeof o.toIndex === 'number' && Number.isFinite(o.toIndex)
    default:
      return false
  }
}

export function parseVibePatchOpsFromLlmText(
  text: string
): { ok: true; ops: VibePatchOp[] } | { ok: false; error: string } {
  const raw = stripMarkdownJsonFence(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  let list: unknown[] | null = null
  if (Array.isArray(parsed)) list = parsed
  else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { ops?: unknown }).ops)) {
    list = (parsed as { ops: unknown[] }).ops
  }
  if (!list) return { ok: false, error: 'Expected a JSON array or { "ops": [...] }' }
  const ops: VibePatchOp[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!isVibePatchOp(item)) return { ok: false, error: `Item ${i} is not a valid vibe patch op` }
    ops.push(item)
  }
  return { ok: true, ops }
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** Google AI Studio / Gemini `generateContent` (uses `X-goog-api-key`, not Bearer). */
export function isGeminiGenerateContentEndpoint(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.hostname === 'generativelanguage.googleapis.com' && u.pathname.includes(':generateContent')
    )
  } catch {
    return false
  }
}

function textFromGeminiResponse(data: unknown): { ok: true; text: string } | { ok: false; error: string } {
  const o = data as Record<string, unknown>
  const err = o?.error as Record<string, unknown> | undefined
  if (err && typeof err.message === 'string') {
    return { ok: false, error: err.message }
  }
  const candidates = o?.candidates as unknown[] | undefined
  const first = candidates?.[0] as Record<string, unknown> | undefined
  if (!first) {
    const fb = o?.promptFeedback as Record<string, unknown> | undefined
    const br = fb?.blockReason
    if (typeof br === 'string') return { ok: false, error: `Blocked: ${br}` }
    return { ok: false, error: 'No candidates in response' }
  }
  const content = first.content as Record<string, unknown> | undefined
  const parts = content?.parts as unknown[] | undefined
  if (!parts?.length) return { ok: false, error: 'No content parts in response' }
  const chunks: string[] = []
  for (const p of parts) {
    const part = p as Record<string, unknown>
    if (typeof part.text === 'string') chunks.push(part.text)
  }
  if (chunks.length === 0) return { ok: false, error: 'No text in response parts' }
  return { ok: true, text: chunks.join('') }
}

async function fetchGeminiGenerateContent(params: {
  endpoint: string
  apiKey: string
  systemText: string
  userText: string
  signal?: AbortSignal
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const { endpoint, apiKey, systemText, userText, signal } = params
  if (!apiKey.trim()) {
    return { ok: false, error: 'API key required for Gemini (X-goog-api-key).' }
  }

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey.trim(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemText }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.2 },
      }),
      signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, error: 'aborted' }
    }
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }

  let data: unknown
  try {
    data = (await res.json()) as unknown
  } catch {
    return { ok: false, error: 'Response was not JSON' }
  }

  if (!res.ok) {
    const parsed = textFromGeminiResponse(data)
    if (!parsed.ok) return { ok: false, error: `HTTP ${res.status}: ${parsed.error}` }
    return { ok: false, error: `HTTP ${res.status}` }
  }

  const parsed = textFromGeminiResponse(data)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  return { ok: true, content: parsed.text }
}

/** OpenAI-compatible chat or Gemini `generateContent`, depending on endpoint URL. */
export async function fetchDesignLlmReply(params: {
  endpoint: string
  apiKey?: string
  model: string
  systemPrompt: string
  userContent: string
  signal?: AbortSignal
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const { endpoint, apiKey, model, systemPrompt, userContent, signal } = params
  if (isGeminiGenerateContentEndpoint(endpoint)) {
    return fetchGeminiGenerateContent({
      endpoint,
      apiKey: apiKey ?? '',
      systemText: systemPrompt,
      userText: userContent,
      signal,
    })
  }
  return fetchOpenAiCompatibleChat({
    endpoint,
    apiKey,
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    signal,
  })
}

export async function fetchOpenAiCompatibleChat(params: {
  endpoint: string
  apiKey?: string
  model: string
  messages: ChatMessage[]
  signal?: AbortSignal
}): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const { endpoint, apiKey, model, messages, signal } = params
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
      signal,
    })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, error: 'aborted' }
    }
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' }
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status}: ${t.slice(0, 400)}` }
  }

  let data: unknown
  try {
    data = (await res.json()) as unknown
  } catch {
    return { ok: false, error: 'Response was not JSON' }
  }
  const o = data as Record<string, unknown>
  const choices = o?.choices as unknown[] | undefined
  const first = choices?.[0] as Record<string, unknown> | undefined
  const message = first?.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content !== 'string') {
    return { ok: false, error: 'No assistant message in response' }
  }
  return { ok: true, content }
}
