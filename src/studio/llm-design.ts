import type { PatchOp } from './patch.ts'

const AI_STORAGE_ENDPOINT = 'pop-ai-endpoint'
const AI_STORAGE_KEY = 'pop-ai-key'
const AI_STORAGE_MODEL = 'pop-ai-model'

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

/** Instructions for OpenAI-style chat completions that return patch ops JSON. */
export function buildDesignLlmSystemPrompt(): string {
  return `You are a design assistant for POP, a browser SVG editor. You output ONLY valid JSON: either a JSON array of patch operations, or a single object {\"ops\": [...]}.

Each operation is an object with an "op" field. Allowed ops:

- {"op":"setMeta","name?":string}
- {"op":"setTokens","tokens":object} — merge into design tokens { colors?, radii?, space? }
- {"op":"setToken","namespace":"colors"|"radii"|"space","key":string,"value":string|number}
- {"op":"addFrame","frame":{"label":string,"x":number,"y":number,"width":number,"height":number,"id?":string,"rootIds?":string[]}}
- {"op":"updateFrame","id":string,"patch":{"label?","x?","y?","width?","height?"}}
- {"op":"removeFrame","id":string} — cannot remove the last frame
- {"op":"setActiveFrame","id":string}
- {"op":"addNode","node":SceneNode} — full node with new UUID "id", correct "parentId", type rect|ellipse|text|image|group|instance
- {"op":"updateNode","id":string,"patch":object} — partial fields merged into existing node
- {"op":"removeNode","id":string}
- {"op":"setFrameRoots","frameId":string,"rootIds":string[]}

Scene nodes (addNode / updateNode) must match POP schema:
- rect: id, parentId, type "rect", x, y, width, height, fill, stroke, strokeWidth, rx, opacity (0–1)
- ellipse: same without rx (no rx on ellipse)
- text: id, parentId, type "text", x, y, width, height, content, fontSize, fill, opacity, fontFamily, fontWeight, letterSpacing, lineHeight
- image: href (data URL or URL), dimensions, opacity
- group: childIds array, x,y,width,height, optional layout, exportRole
- instance: componentId, dimensions

For NEW nodes use fresh UUID strings (RFC4122). parentId is null for frame roots; add new roots with setFrameRoots including previous roots plus the new id, in paint order (later = on top).

Prefer small, safe edits: updateNode for style moves, addNode + setFrameRoots for new shapes. Do not invent node ids: use ids from the document for updates, new UUIDs only for addNode.

No markdown, no commentary outside the JSON.`
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

function isPatchOp(x: unknown): x is PatchOp {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.op === 'string'
}

export function parsePatchOpsFromLlmText(text: string): { ok: true; ops: PatchOp[] } | { ok: false; error: string } {
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
  const ops: PatchOp[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!isPatchOp(item)) return { ok: false, error: `Item ${i} is not a valid patch op` }
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
