import type { ComponentDefinition, SceneLeaf, SceneNode } from './scene-types.ts'

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function svgNum(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

function opacityAttr(opacity: number): string {
  if (opacity >= 1) return ''
  const t = Math.round(opacity * 1000) / 1000
  return ` opacity="${t}"`
}

function rectCornerAttrs(rx: number, width: number, height: number): string {
  const maxR = Math.min(width, height) / 2
  const r = Math.max(0, Math.min(rx, maxR))
  if (r <= 0) return ''
  const s = svgNum(r)
  return ` rx="${s}" ry="${s}"`
}

export function itemLabel(item: SceneNode, definitions: Map<string, ComponentDefinition>): string {
  switch (item.type) {
    case 'rect':
      return 'Rectangle'
    case 'ellipse':
      return 'Ellipse'
    case 'text':
      return item.content.slice(0, 24) || 'Text'
    case 'image':
      return 'Image'
    case 'group':
      return 'Group'
    case 'instance': {
      const d = definitions.get(item.componentId)
      return d ? `Instance · ${d.name}` : 'Instance'
    }
  }
}

export function buildSvgFragmentLeaf(item: SceneLeaf): string {
  switch (item.type) {
    case 'rect':
      return `<rect x="${svgNum(item.x)}" y="${svgNum(item.y)}" width="${svgNum(item.width)}" height="${svgNum(item.height)}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${svgNum(item.strokeWidth)}"${rectCornerAttrs(item.rx, item.width, item.height)}${opacityAttr(item.opacity)}/>`
    case 'ellipse': {
      const cx = item.x + item.width / 2
      const cy = item.y + item.height / 2
      const rx = item.width / 2
      const ry = item.height / 2
      return `<ellipse cx="${svgNum(cx)}" cy="${svgNum(cy)}" rx="${svgNum(rx)}" ry="${svgNum(ry)}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${svgNum(item.strokeWidth)}"${opacityAttr(item.opacity)}/>`
    }
    case 'text': {
      const ff = escapeXml(item.fontFamily || 'system-ui, sans-serif')
      const fw = item.fontWeight ?? 400
      const ls = item.letterSpacing ?? 0
      const lh = item.lineHeight ?? 1.2
      return `<text x="${svgNum(item.x)}" y="${svgNum(item.y + item.fontSize)}" font-size="${svgNum(item.fontSize)}" font-family="${ff}" font-weight="${fw}" letter-spacing="${svgNum(ls)}" fill="${escapeXml(item.fill)}"${opacityAttr(item.opacity)}><tspan style="line-height:${svgNum(lh)}">${escapeXml(item.content)}</tspan></text>`
    }
    case 'image':
      return `<image href="${escapeXml(item.href)}" x="${svgNum(item.x)}" y="${svgNum(item.y)}" width="${svgNum(item.width)}" height="${svgNum(item.height)}" preserveAspectRatio="none"${opacityAttr(item.opacity)}/>`
  }
}

/** Same geometry as `buildSvgFragmentLeaf` but with parent `<g>` already translated by (item.x, item.y). */
export function buildSvgFragmentLeafLocal(item: SceneLeaf): string {
  switch (item.type) {
    case 'rect':
      return `<rect x="0" y="0" width="${svgNum(item.width)}" height="${svgNum(item.height)}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${svgNum(item.strokeWidth)}"${rectCornerAttrs(item.rx, item.width, item.height)}${opacityAttr(item.opacity)}/>`
    case 'ellipse': {
      const rx = item.width / 2
      const ry = item.height / 2
      return `<ellipse cx="${svgNum(rx)}" cy="${svgNum(ry)}" rx="${svgNum(rx)}" ry="${svgNum(ry)}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${svgNum(item.strokeWidth)}"${opacityAttr(item.opacity)}/>`
    }
    case 'text': {
      const ff = escapeXml(item.fontFamily || 'system-ui, sans-serif')
      const fw = item.fontWeight ?? 400
      const ls = item.letterSpacing ?? 0
      const lh = item.lineHeight ?? 1.2
      return `<text x="0" y="${svgNum(item.fontSize)}" font-size="${svgNum(item.fontSize)}" font-family="${ff}" font-weight="${fw}" letter-spacing="${svgNum(ls)}" fill="${escapeXml(item.fill)}"${opacityAttr(item.opacity)}><tspan style="line-height:${svgNum(lh)}">${escapeXml(item.content)}</tspan></text>`
    }
    case 'image':
      return `<image href="${escapeXml(item.href)}" x="0" y="0" width="${svgNum(item.width)}" height="${svgNum(item.height)}" preserveAspectRatio="none"${opacityAttr(item.opacity)}/>`
  }
}

export function serializeDefSubtreeSvg(def: ComponentDefinition, id: string, indent: string): string {
  const n = def.nodes[id]
  if (!n) return ''
  if (n.type === 'group') {
    const inner = n.childIds.map((cid) => serializeDefSubtreeSvg(def, cid, `${indent}  `)).join('\n')
    return `${indent}<g transform="translate(${n.x} ${n.y})">\n${inner}\n${indent}</g>`
  }
  return `${indent}${buildSvgFragmentLeaf(n)}`
}

export function serializeSceneSubtreeSvg(
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  id: string,
  indent: string,
): string {
  const n = nodes.get(id)
  if (!n) return ''
  if (n.type === 'group') {
    const inner = n.childIds
      .map((cid) => serializeSceneSubtreeSvg(nodes, definitions, cid, `${indent}  `))
      .join('\n')
    return `${indent}<g transform="translate(${n.x} ${n.y})">\n${inner}\n${indent}</g>`
  }
  if (n.type === 'instance') {
    const def = definitions.get(n.componentId)
    if (!def) return ''
    const sx = n.width / Math.max(1e-6, def.intrinsicW)
    const sy = n.height / Math.max(1e-6, def.intrinsicH)
    const inner = serializeDefSubtreeSvg(def, def.rootId, `${indent}  `)
    return `${indent}<g transform="translate(${n.x} ${n.y}) scale(${sx} ${sy})">\n${inner}\n${indent}</g>`
  }
  return `${indent}${buildSvgFragmentLeaf(n)}`
}

export function serializeSvgFromRoots(
  rootIds: string[],
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  w: number,
  h: number,
): string {
  const body = rootIds.map((rid) => serializeSceneSubtreeSvg(nodes, definitions, rid, '  ')).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
${body}
</svg>
`
}

export function downloadSvg(svg: string, filename: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.click()
  URL.revokeObjectURL(url)
}
