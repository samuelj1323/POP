import type { DesignTokens } from './document.ts'
import type { SceneLeaf } from './scene-types.ts'

/** Slug for CSS custom property suffix (stable, safe for --pop-*-slug). */
export function tokenSlug(key: string): string {
  const s = key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s || 'token'
}

export function resolveColorFromTokens(
  literal: string,
  tokenKey: string | undefined,
  colors: Record<string, string> | undefined,
): string {
  if (tokenKey && colors && typeof colors[tokenKey] === 'string') return colors[tokenKey]
  return literal
}

export function resolvedFill(leaf: SceneLeaf, tokens: DesignTokens): string {
  if (leaf.type === 'image') return '#000000'
  const c = tokens.colors ?? {}
  return resolveColorFromTokens(leaf.fill, leaf.fillToken, c)
}

export function resolvedStroke(leaf: SceneLeaf, tokens: DesignTokens): string {
  if (leaf.type !== 'rect' && leaf.type !== 'ellipse') return '#000000'
  const c = tokens.colors ?? {}
  return resolveColorFromTokens(leaf.stroke, leaf.strokeToken, c)
}

/** `:root { --pop-color-* ... }` block for HTML export and copy handoff. */
export function tokensToCssRootBlock(tokens: DesignTokens): string {
  const lines: string[] = [':root {']
  for (const [k, v] of Object.entries(tokens.colors ?? {})) {
    if (typeof v === 'string') lines.push(`  --pop-color-${tokenSlug(k)}: ${v};`)
  }
  for (const [k, v] of Object.entries(tokens.radii ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) lines.push(`  --pop-radius-${tokenSlug(k)}: ${v}px;`)
  }
  for (const [k, v] of Object.entries(tokens.space ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) lines.push(`  --pop-space-${tokenSlug(k)}: ${v}px;`)
  }
  lines.push('}')
  return lines.join('\n')
}

export function tokensToJson(tokens: DesignTokens): string {
  return JSON.stringify(
    {
      colors: tokens.colors ?? {},
      radii: tokens.radii ?? {},
      space: tokens.space ?? {},
    },
    null,
    2,
  )
}
