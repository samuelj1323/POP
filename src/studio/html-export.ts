import type { DesignTokens, PopFrame } from './document.ts'
import { resolveColorFromTokens, tokenSlug, tokensToCssRootBlock } from './design-tokens.ts'
import { worldFrame } from './layout-geometry.ts'
import type { ComponentDefinition, HtmlExportRole, SceneNode } from './scene-types.ts'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function px(n: number): string {
  return `${Math.round(n * 1000) / 1000}px`
}

function groupTag(role: HtmlExportRole | undefined): string {
  switch (role) {
    case 'button':
      return 'button'
    case 'section':
      return 'section'
    case 'main':
      return 'main'
    case 'header':
      return 'header'
    case 'footer':
      return 'footer'
    case 'nav':
      return 'nav'
    case 'card':
      return 'article'
    case 'div':
    case 'auto':
    default:
      return 'div'
  }
}

function rgbaFromHex(hex: string, opacity: number): string {
  const h = hex.replace('#', '')
  if (h.length !== 6) return hex
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  if (opacity >= 1) return hex
  return `rgba(${r},${g},${b},${opacity})`
}

export type HtmlExportOptions = {
  title?: string
  /** Injected as `<link rel="stylesheet">` before inline styles (design system CSS, fonts). */
  stylesheetUrls?: string[]
}

export function exportFrameToHtml(
  frame: PopFrame,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  tokens: DesignTokens,
  options?: HtmlExportOptions,
): string {
  const title = escapeHtml(options?.title ?? frame.label)
  const body = frame.rootIds.map((rid) => emitRoot(rid, frame, nodes, definitions, tokens)).join('\n')
  const cssVars = tokensToCssRootBlock(tokens)
  const extraLinks = (options?.stylesheetUrls ?? [])
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .map((href) => `  <link rel="stylesheet" href="${escapeHtml(href)}" />`)
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
${extraLinks ? `${extraLinks}\n` : ''}  <style>
    * { box-sizing: border-box; }
    ${cssVars}
    body { margin: 0; min-height: 100vh; font-family: system-ui, sans-serif; }
    .pop-frame {
      position: relative;
      width: ${px(frame.width)};
      height: ${px(frame.height)};
      margin: 2rem auto;
      background: #181c27;
      overflow: hidden;
    }
    .pop-abs { position: absolute; }
    .pop-stack { box-sizing: border-box; }
    .pop-ellipse { border-radius: 50%; }
    button.pop-abs { font: inherit; cursor: default; border: none; text-align: inherit; }
  </style>
</head>
<body>
  <div class="pop-frame" data-pop-frame="${escapeHtml(frame.id)}" data-pop-frame-label="${escapeHtml(frame.label)}">
${body}
  </div>
</body>
</html>
`
}

function emitRoot(
  rootId: string,
  frame: PopFrame,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  tokens: DesignTokens,
): string {
  return emitNode(rootId, frame, nodes, definitions, tokens)
}

function emitNode(
  id: string,
  frame: PopFrame,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  tokens: DesignTokens,
): string {
  const n = nodes.get(id)
  if (!n) return ''
  const wf = worldFrame(nodes, definitions, id)
  if (!wf) return ''

  const left = wf.x - frame.x
  const top = wf.y - frame.y
  const popAttrs = ` data-pop-node="${escapeHtml(id)}" data-pop-kind="${escapeHtml(n.type)}"`

  if (n.type === 'instance') {
    const def = definitions.get(n.componentId)
    if (!def) return ''
    const sx = wf.width / Math.max(1e-6, def.intrinsicW)
    const sy = wf.height / Math.max(1e-6, def.intrinsicH)
    const inner = emitDefAt(def, def.rootId, 0, 0, tokens)
    return `<div class="pop-abs"${popAttrs} style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};overflow:hidden"><div style="width:${px(def.intrinsicW)};height:${px(def.intrinsicH)};transform:scale(${sx},${sy});transform-origin:0 0">${inner}</div></div>`
  }

  if (n.type === 'group') {
    const layout = n.layout
    if (layout && layout.type === 'stack') {
      const fd = layout.direction === 'horizontal' ? 'row' : 'column'
      const tag = groupTag(n.exportRole)
      const isBtn = tag === 'button'
      const pad = px(layout.padding)
      const gap = px(layout.gap)
      const common = `class="pop-abs pop-stack"${popAttrs} style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};display:flex;flex-direction:${fd};gap:${gap};padding:${pad};box-sizing:border-box"`
      const kids = n.childIds.map((cid) => emitNode(cid, frame, nodes, definitions, tokens)).join('\n')
      if (isBtn) {
        return `<button type="button" ${common}>${kids}</button>`
      }
      return `<${tag} ${common}>${kids}</${tag}>`
    }
    const tag = groupTag(n.exportRole)
    const kids = n.childIds.map((cid) => emitNode(cid, frame, nodes, definitions, tokens)).join('\n')
    if (tag === 'button') {
      return `<button type="button" class="pop-abs"${popAttrs} style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};position:relative">${kids}</button>`
    }
    return `<${tag} class="pop-abs"${popAttrs} style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};position:relative">${kids}</${tag}>`
  }

  if (n.type === 'rect') {
    const fillCss = cssFillValue(n.fill, n.fillToken, n.opacity, tokens.colors)
    const border =
      n.strokeWidth > 0
        ? `${px(n.strokeWidth)} solid ${cssStrokeValue(n.stroke, n.strokeToken, n.opacity, tokens.colors)}`
        : 'none'
    const rx = n.rx > 0 ? `${px(Math.min(n.rx, n.width / 2, n.height / 2))}` : '0'
    const fillTokAttr = n.fillToken ? ` data-pop-fill-token="${escapeHtml(n.fillToken)}"` : ''
    const strokeTokAttr = n.strokeToken ? ` data-pop-stroke-token="${escapeHtml(n.strokeToken)}"` : ''
    return `<div class="pop-abs"${popAttrs}${fillTokAttr}${strokeTokAttr} style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};background:${fillCss};border:${border};border-radius:${rx};opacity:${n.opacity}"></div>`
  }

  if (n.type === 'ellipse') {
    const fillCss = cssFillValue(n.fill, n.fillToken, n.opacity, tokens.colors)
    const border =
      n.strokeWidth > 0
        ? `${px(n.strokeWidth)} solid ${cssStrokeValue(n.stroke, n.strokeToken, n.opacity, tokens.colors)}`
        : 'none'
    const fillTokAttr = n.fillToken ? ` data-pop-fill-token="${escapeHtml(n.fillToken)}"` : ''
    const strokeTokAttr = n.strokeToken ? ` data-pop-stroke-token="${escapeHtml(n.strokeToken)}"` : ''
    return `<div class="pop-abs pop-ellipse"${popAttrs}${fillTokAttr}${strokeTokAttr} style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};background:${fillCss};border:${border};opacity:${n.opacity}"></div>`
  }

  if (n.type === 'text') {
    const ff = escapeHtml(n.fontFamily)
    const fs = px(n.fontSize)
    const fw = n.fontWeight
    const ls = px(n.letterSpacing)
    const lh = n.lineHeight
    const col = cssFillValue(n.fill, n.fillToken, n.opacity, tokens.colors)
    const fillTokAttr = n.fillToken ? ` data-pop-fill-token="${escapeHtml(n.fillToken)}"` : ''
    return `<div class="pop-abs"${popAttrs}${fillTokAttr} style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};font-family:${ff},sans-serif;font-size:${fs};font-weight:${fw};letter-spacing:${ls};line-height:${lh};color:${col};opacity:${n.opacity};white-space:pre-wrap;overflow:hidden">${escapeHtml(n.content)}</div>`
  }

  if (n.type === 'image') {
    return `<img class="pop-abs" alt=""${popAttrs} src="${escapeHtml(n.href)}" style="left:${px(left)};top:${px(top)};width:${px(wf.width)};height:${px(wf.height)};opacity:${n.opacity};object-fit:fill" />`
  }

  return ''
}

function cssFillValue(
  literal: string,
  fillToken: string | undefined,
  opacity: number,
  colors: Record<string, string> | undefined,
): string {
  if (fillToken && colors?.[fillToken]) {
    if (opacity >= 1) return `var(--pop-color-${tokenSlug(fillToken)})`
    return `color-mix(in srgb, var(--pop-color-${tokenSlug(fillToken)}) ${Math.round(opacity * 100)}%, transparent)`
  }
  return rgbaFromHex(resolveColorFromTokens(literal, fillToken, colors), opacity)
}

function cssStrokeValue(
  literal: string,
  strokeToken: string | undefined,
  opacity: number,
  colors: Record<string, string> | undefined,
): string {
  if (strokeToken && colors?.[strokeToken]) {
    if (opacity >= 1) return `var(--pop-color-${tokenSlug(strokeToken)})`
    return `color-mix(in srgb, var(--pop-color-${tokenSlug(strokeToken)}) ${Math.round(opacity * 100)}%, transparent)`
  }
  return rgbaFromHex(resolveColorFromTokens(literal, strokeToken, colors), opacity)
}

/** Render definition subtree; parent origin so node world origin is (parentX+n.x, parentY+n.y). */
function emitDefAt(
  def: ComponentDefinition,
  id: string,
  parentX: number,
  parentY: number,
  tokens: DesignTokens,
): string {
  const n = def.nodes[id]
  if (!n) return ''
  const ox = parentX + n.x
  const oy = parentY + n.y
  const popAttrs = ` data-pop-def="1" data-pop-kind="${escapeHtml(n.type)}"`

  if (n.type === 'group') {
    const layout = n.layout
    if (layout && layout.type === 'stack') {
      const fd = layout.direction === 'horizontal' ? 'row' : 'column'
      const pad = px(layout.padding)
      const gap = px(layout.gap)
      const kids = n.childIds.map((cid) => emitDefAt(def, cid, ox, oy, tokens)).join('\n')
      return `<div class="pop-stack"${popAttrs} style="position:absolute;left:${px(ox)};top:${px(oy)};display:flex;flex-direction:${fd};gap:${gap};padding:${pad};width:${px(n.width)};height:${px(n.height)};box-sizing:border-box">${kids}</div>`
    }
    const kids = n.childIds.map((cid) => emitDefAt(def, cid, ox, oy, tokens)).join('\n')
    return `<div${popAttrs} style="position:absolute;left:${px(ox)};top:${px(oy)};width:${px(n.width)};height:${px(n.height)};position:relative">${kids}</div>`
  }

  if (n.type === 'rect') {
    const bg = cssFillValue(n.fill, n.fillToken, n.opacity, tokens.colors)
    const border =
      n.strokeWidth > 0
        ? `${px(n.strokeWidth)} solid ${cssStrokeValue(n.stroke, n.strokeToken, n.opacity, tokens.colors)}`
        : 'none'
    const rx = n.rx > 0 ? `${px(Math.min(n.rx, n.width / 2, n.height / 2))}` : '0'
    return `<div${popAttrs} style="position:absolute;left:${px(ox)};top:${px(oy)};width:${px(n.width)};height:${px(n.height)};background:${bg};border:${border};border-radius:${rx};opacity:${n.opacity}"></div>`
  }
  if (n.type === 'ellipse') {
    const bg = cssFillValue(n.fill, n.fillToken, n.opacity, tokens.colors)
    const border =
      n.strokeWidth > 0
        ? `${px(n.strokeWidth)} solid ${cssStrokeValue(n.stroke, n.strokeToken, n.opacity, tokens.colors)}`
        : 'none'
    return `<div class="pop-ellipse"${popAttrs} style="position:absolute;left:${px(ox)};top:${px(oy)};width:${px(n.width)};height:${px(n.height)};background:${bg};border:${border};opacity:${n.opacity}"></div>`
  }
  if (n.type === 'text') {
    const ff = escapeHtml(n.fontFamily)
    const fs = px(n.fontSize)
    const col = cssFillValue(n.fill, n.fillToken, n.opacity, tokens.colors)
    return `<div${popAttrs} style="position:absolute;left:${px(ox)};top:${px(oy)};width:${px(n.width)};height:${px(n.height)};font-family:${ff},sans-serif;font-size:${fs};font-weight:${n.fontWeight};letter-spacing:${px(n.letterSpacing)};line-height:${n.lineHeight};color:${col};opacity:${n.opacity};white-space:pre-wrap;overflow:hidden">${escapeHtml(n.content)}</div>`
  }
  if (n.type === 'image') {
    return `<img alt=""${popAttrs} src="${escapeHtml(n.href)}" style="position:absolute;left:${px(ox)};top:${px(oy)};width:${px(n.width)};height:${px(n.height)};object-fit:fill;opacity:${n.opacity}" />`
  }
  return ''
}

/** Download HTML as a file (browser). */
export function downloadHtml(html: string, filename: string): void {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.click()
  URL.revokeObjectURL(url)
}
