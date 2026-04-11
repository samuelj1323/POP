import type { VibePatchOp } from './vibe-patch.ts'

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
1) **Library** — reusable components: each has an id, display name, and HTML fragment (inline CSS or <style> blocks).
2) **Page** — ordered list of **placements**. Each placement has its own id and references a library component via componentId. The iframe preview renders **only** these placements, in order—not the whole library.

You output ONLY valid JSON: either a JSON array of patch operations, or a single object {"ops": [...]}.

Each operation is an object with an "op" field. Allowed ops:

**Library**
- {"op":"addComponent","component":{"name":string,"html":string,"id"?:string}} — adds a definition to the library (not automatically on the page). Optional id must be a new UUID if provided.
- {"op":"updateComponent","id":string,"patch":{"name"?:string,"html"?:string}} — merge into an existing library component.
- {"op":"removeComponent","id":string} — removes from library and removes all page placements that reference that componentId.

**Page (preview)**
- {"op":"addPagePlacement","componentId":string,"placementId"?:string} — append one instance of a library component to the page. componentId must exist in the library. Optional placementId = new UUID if omitted.
- {"op":"removePagePlacement","id":string} — remove one placement by its id (from pagePlacements in context).
- {"op":"movePagePlacement","id":string,"toIndex":number} — move the placement to a zero-based index in the current page list after removal (0 = top; use length to append).

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
      return true
    }
    case 'updateComponent': {
      if (typeof o.id !== 'string') return false
      const p = o.patch as Record<string, unknown> | undefined
      if (!p || typeof p !== 'object') return false
      if (p.name !== undefined && typeof p.name !== 'string') return false
      if (p.html !== undefined && typeof p.html !== 'string') return false
      return true
    }
    case 'removeComponent':
      return typeof o.id === 'string'
    case 'addPagePlacement': {
      if (typeof o.componentId !== 'string') return false
      if (o.placementId !== undefined && typeof o.placementId !== 'string') return false
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
