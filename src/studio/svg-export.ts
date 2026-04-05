import type { ComponentDefinition, SceneLeaf, SceneNode } from './scene-types.ts'

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
      return `<rect x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${item.strokeWidth}"/>`
    case 'ellipse': {
      const cx = item.x + item.width / 2
      const cy = item.y + item.height / 2
      const rx = item.width / 2
      const ry = item.height / 2
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${item.strokeWidth}"/>`
    }
    case 'text':
      return `<text x="${item.x}" y="${item.y + item.fontSize}" font-size="${item.fontSize}" font-family="system-ui, sans-serif" fill="${escapeXml(item.fill)}">${escapeXml(item.content)}</text>`
    case 'image':
      return `<image href="${escapeXml(item.href)}" x="${item.x}" y="${item.y}" width="${item.width}" height="${item.height}" preserveAspectRatio="none"/>`
  }
}

/** Same geometry as `buildSvgFragmentLeaf` but with parent `<g>` already translated by (item.x, item.y). */
export function buildSvgFragmentLeafLocal(item: SceneLeaf): string {
  switch (item.type) {
    case 'rect':
      return `<rect x="0" y="0" width="${item.width}" height="${item.height}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${item.strokeWidth}"/>`
    case 'ellipse': {
      const rx = item.width / 2
      const ry = item.height / 2
      return `<ellipse cx="${rx}" cy="${ry}" rx="${rx}" ry="${ry}" fill="${escapeXml(item.fill)}" stroke="${escapeXml(item.stroke)}" stroke-width="${item.strokeWidth}"/>`
    }
    case 'text':
      return `<text x="0" y="${item.fontSize}" font-size="${item.fontSize}" font-family="system-ui, sans-serif" fill="${escapeXml(item.fill)}">${escapeXml(item.content)}</text>`
    case 'image':
      return `<image href="${escapeXml(item.href)}" x="0" y="0" width="${item.width}" height="${item.height}" preserveAspectRatio="none"/>`
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
