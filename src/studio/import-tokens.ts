import type { DesignTokens } from './document.ts'
import { normalizeHex6 } from './color-palette.ts'

function ensureBuckets(out: DesignTokens): void {
  if (!out.colors) out.colors = {}
  if (!out.radii) out.radii = {}
  if (!out.space) out.space = {}
}

/** Merge b into a; b wins on key collision. */
export function mergeDesignTokens(a: DesignTokens, b: DesignTokens): DesignTokens {
  ensureBuckets(a)
  ensureBuckets(b)
  return {
    colors: { ...a.colors, ...b.colors },
    radii: { ...a.radii, ...b.radii },
    space: { ...a.space, ...b.space },
  }
}

function parseColorValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (t.startsWith('#')) return normalizeHex6(t)
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(t)
  if (m) {
    const r = Number(m[1])
    const g = Number(m[2])
    const b = Number(m[3])
    if ([r, g, b].every((n) => Number.isFinite(n)))
      return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
  }
  return null
}

function parseDimensionToPx(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>
    if (typeof o.value === 'number' && Number.isFinite(o.value)) return o.value
    if (typeof o.value === 'string') return parseDimensionToPx(o.value)
  }
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return null
  if (t.endsWith('rem') || t.endsWith('em')) return Math.round(n * 16)
  return Math.round(n)
}

function tokenKeyFromPath(path: string[]): string {
  return path
    .map((p) => p.replace(/\s+/g, '-'))
    .filter(Boolean)
    .join('-')
}

function bucketForDimensionPath(path: string[]): 'radii' | 'space' {
  const p = path.join('-').toLowerCase()
  if (
    p.includes('radius') ||
    p.includes('radii') ||
    p.includes('corner') ||
    p.includes('round') ||
    p.includes('border-radius')
  )
    return 'radii'
  return 'space'
}

/** Walk Design Tokens Community Group–style trees ($type + $value). */
function walkDtcg(obj: unknown, path: string[], out: DesignTokens): void {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return
  const o = obj as Record<string, unknown>

  if ('$value' in o && '$type' in o) {
    const t = o.$type
    const v = o.$value
    const key = tokenKeyFromPath(path) || 'token'
    ensureBuckets(out)
    if (t === 'color') {
      const hex = parseColorValue(v)
      if (hex) out.colors![key] = hex
    } else if (t === 'dimension' || t === 'spacing' || t === 'borderRadius') {
      const px = parseDimensionToPx(
        typeof v === 'object' && v && 'value' in (v as object)
          ? (v as { value: unknown }).value
          : v,
      )
      if (px !== null && px >= 0) {
        if (t === 'borderRadius' || bucketForDimensionPath(path) === 'radii') out.radii![key] = px
        else out.space![key] = px
      }
    }
    return
  }

  for (const [k, child] of Object.entries(o)) {
    if (k.startsWith('$')) continue
    walkDtcg(child, [...path, k], out)
  }
}

/** Parse POP-native `{ colors, radii, space }` if present. */
function tryPopNative(input: Record<string, unknown>): DesignTokens | null {
  const hasAny =
    (input.colors && typeof input.colors === 'object') ||
    (input.radii && typeof input.radii === 'object') ||
    (input.space && typeof input.space === 'object')
  if (!hasAny) return null
  const out: DesignTokens = {}
  ensureBuckets(out)
  if (input.colors && typeof input.colors === 'object' && !Array.isArray(input.colors)) {
    for (const [k, v] of Object.entries(input.colors as Record<string, unknown>)) {
      if (typeof v === 'string') {
        const hex = parseColorValue(v)
        if (hex) out.colors![k] = hex
      }
    }
  }
  if (input.radii && typeof input.radii === 'object' && !Array.isArray(input.radii)) {
    for (const [k, v] of Object.entries(input.radii as Record<string, unknown>)) {
      const px = typeof v === 'number' ? v : parseDimensionToPx(v)
      if (px !== null && Number.isFinite(px)) out.radii![k] = px
    }
  }
  if (input.space && typeof input.space === 'object' && !Array.isArray(input.space)) {
    for (const [k, v] of Object.entries(input.space as Record<string, unknown>)) {
      const px = typeof v === 'number' ? v : parseDimensionToPx(v)
      if (px !== null && Number.isFinite(px)) out.space![k] = px
    }
  }
  return out
}

export type ImportTokensResult =
  | { ok: true; tokens: DesignTokens }
  | { ok: false; message: string }

/**
 * Import design tokens from arbitrary JSON (POP shape, DTCG-style trees, or a flat color map).
 */
export function importDesignTokensFromJson(input: unknown): ImportTokensResult {
  if (input === null || input === undefined) {
    return { ok: false, message: 'Empty JSON.' }
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Root value must be a JSON object.' }
  }
  const root = input as Record<string, unknown>

  const embedded =
    root.tokens && typeof root.tokens === 'object' && !Array.isArray(root.tokens)
      ? tryPopNative(root.tokens as Record<string, unknown>)
      : null
  if (
    embedded &&
    (Object.keys(embedded.colors ?? {}).length > 0 ||
      Object.keys(embedded.radii ?? {}).length > 0 ||
      Object.keys(embedded.space ?? {}).length > 0)
  ) {
    return { ok: true, tokens: embedded }
  }

  const native = tryPopNative(root)
  if (native && (Object.keys(native.colors ?? {}).length > 0 || Object.keys(native.radii ?? {}).length > 0 || Object.keys(native.space ?? {}).length > 0)) {
    return { ok: true, tokens: native }
  }

  const dtcg: DesignTokens = {}
  walkDtcg(root, [], dtcg)
  ensureBuckets(dtcg)
  const dtcgCount =
    Object.keys(dtcg.colors ?? {}).length +
    Object.keys(dtcg.radii ?? {}).length +
    Object.keys(dtcg.space ?? {}).length
  if (dtcgCount > 0) {
    return { ok: true, tokens: dtcg }
  }

  const flatColors: Record<string, string> = {}
  for (const [k, v] of Object.entries(root)) {
    if (k.startsWith('$') || k === 'colors' || k === 'radii' || k === 'space') continue
    if (typeof v === 'string') {
      const hex = parseColorValue(v)
      if (hex) flatColors[k] = hex
    }
  }
  if (Object.keys(flatColors).length > 0) {
    return { ok: true, tokens: { colors: flatColors, radii: {}, space: {} } }
  }

  return {
    ok: false,
    message:
      'Could not find tokens. Use POP format { colors, radii, space }, W3C/DTCG groups with $type/$value, or a flat map of color hex strings.',
  }
}
