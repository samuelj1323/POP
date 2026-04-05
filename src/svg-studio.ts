const VIEW_W = 960
const VIEW_H = 540
const SNAP_PX = 8

type Tool = 'select' | 'rect' | 'ellipse' | 'text' | 'image'

type SceneNodeBase = { id: string; parentId: string | null }

type SceneLeaf =
  | (SceneNodeBase & {
      type: 'rect'
      x: number
      y: number
      width: number
      height: number
      fill: string
      stroke: string
      strokeWidth: number
    })
  | (SceneNodeBase & {
      type: 'ellipse'
      x: number
      y: number
      width: number
      height: number
      fill: string
      stroke: string
      strokeWidth: number
    })
  | (SceneNodeBase & {
      type: 'text'
      x: number
      y: number
      width: number
      height: number
      content: string
      fontSize: number
      fill: string
    })
  | (SceneNodeBase & {
      type: 'image'
      x: number
      y: number
      width: number
      height: number
      href: string
    })

type SceneGroup = SceneNodeBase & {
  type: 'group'
  x: number
  y: number
  width: number
  height: number
  childIds: string[]
}

type SceneInstance = SceneNodeBase & {
  type: 'instance'
  componentId: string
  x: number
  y: number
  width: number
  height: number
}

type SceneNode = SceneLeaf | SceneGroup | SceneInstance

type DefNode = Exclude<SceneNode, { type: 'instance' }>

type ComponentDefinition = {
  id: string
  name: string
  rootId: string
  intrinsicW: number
  intrinsicH: number
  nodes: Record<string, DefNode>
}

/** Legacy flat canvas item (persist v1 only). */
type CanvasItem =
  | {
      id: string
      type: 'rect'
      x: number
      y: number
      width: number
      height: number
      fill: string
      stroke: string
      strokeWidth: number
    }
  | {
      id: string
      type: 'ellipse'
      x: number
      y: number
      width: number
      height: number
      fill: string
      stroke: string
      strokeWidth: number
    }
  | {
      id: string
      type: 'text'
      x: number
      y: number
      width: number
      height: number
      content: string
      fontSize: number
      fill: string
    }
  | {
      id: string
      type: 'image'
      x: number
      y: number
      width: number
      height: number
      href: string
    }

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Normalize to #rrggbb for `<input type="color">` and SVG. */
function normalizeHex6(hex: string): string {
  let h = hex.trim()
  if (!h.startsWith('#')) h = `#${h}`
  h = h.slice(1)
  if (h.length === 3) {
    h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  }
  if (h.length !== 6) return '#000000'
  const n = parseInt(h, 16)
  if (!Number.isFinite(n)) return '#000000'
  return `#${n.toString(16).padStart(6, '0')}`
}

function parseRgbHex(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex6(hex).slice(1)
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function mixRgb(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

/** Grayscale column + tinted columns, similar to Excel’s “Theme colors” grid. */
function buildExcelThemeGrid(): string[][] {
  const grayCol = ['#ffffff', '#f2f2f2', '#d9d9d9', '#bfbfbf', '#a6a6a6', '#7f7f7f']
  const accentBases = [
    '#c00000',
    '#ff6600',
    '#ffc000',
    '#92d050',
    '#00b050',
    '#00b0f0',
    '#0070c0',
    '#002060',
    '#7030a0',
  ]
  const rows = grayCol.length
  const grid: string[][] = []
  for (let r = 0; r < rows; r++) {
    const t = rows === 1 ? 0 : r / (rows - 1)
    const row: string[] = []
    for (let c = 0; c < 10; c++) {
      if (c === 0) {
        row.push(grayCol[r]!)
      } else {
        const base = parseRgbHex(accentBases[c - 1]!)
        const white = { r: 255, g: 255, b: 255 }
        const tinted = mixRgb(white, base, 0.18 + (1 - t) * 0.72)
        const shaded = mixRgb(tinted, { r: 18, g: 18, b: 18 }, t * 0.52)
        row.push(rgbToHex(shaded.r, shaded.g, shaded.b))
      }
    }
    grid.push(row)
  }
  return grid
}

/** Excel-style “Standard colors” row (common fills). */
const EXCEL_STANDARD_COLORS = [
  '#000000',
  '#ffffff',
  '#c00000',
  '#ff0000',
  '#ffc000',
  '#ffff00',
  '#92d050',
  '#00b050',
  '#00b0f0',
  '#0070c0',
]

const MIN_ITEM_SIZE = 8

const MIN_VIEW_SCALE = 0.25
const MAX_VIEW_SCALE = 4

type ResizeHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

function bboxFromOpposingCorners(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; width: number; height: number } {
  const x1 = Math.min(ax, bx)
  const x2 = Math.max(ax, bx)
  const y1 = Math.min(ay, by)
  const y2 = Math.max(ay, by)
  return {
    x: x1,
    y: y1,
    width: Math.max(MIN_ITEM_SIZE, x2 - x1),
    height: Math.max(MIN_ITEM_SIZE, y2 - y1),
  }
}

function applyResizeHandle(
  handle: ResizeHandleId,
  mx: number,
  my: number,
  s: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const x0 = s.x
  const y0 = s.y
  const w0 = s.width
  const h0 = s.height
  const r = x0 + w0
  const b = y0 + h0
  switch (handle) {
    case 'se':
      return bboxFromOpposingCorners(x0, y0, mx, my)
    case 'nw':
      return bboxFromOpposingCorners(r, b, mx, my)
    case 'ne':
      return bboxFromOpposingCorners(x0, b, mx, my)
    case 'sw':
      return bboxFromOpposingCorners(r, y0, mx, my)
    case 'e':
      return { x: x0, y: y0, width: Math.max(MIN_ITEM_SIZE, mx - x0), height: h0 }
    case 'w': {
      const nx = Math.min(mx, r - MIN_ITEM_SIZE)
      return { x: nx, y: y0, width: Math.max(MIN_ITEM_SIZE, r - nx), height: h0 }
    }
    case 's':
      return { x: x0, y: y0, width: w0, height: Math.max(MIN_ITEM_SIZE, my - y0) }
    case 'n': {
      const ny = Math.min(my, b - MIN_ITEM_SIZE)
      return { x: x0, y: ny, width: w0, height: Math.max(MIN_ITEM_SIZE, b - ny) }
    }
  }
}

const HANDLE_CURSORS: Record<ResizeHandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
}

function worldFrame(
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  id: string,
): { x: number; y: number; width: number; height: number } | null {
  const n = nodes.get(id)
  if (!n) return null
  let ox = 0
  let oy = 0
  let cur: string | null = id
  const chain: SceneNode[] = []
  while (cur) {
    const node = nodes.get(cur)
    if (!node) break
    chain.unshift(node)
    cur = node.parentId
  }
  for (const node of chain) {
    ox += node.x
    oy += node.y
  }
  return { x: ox, y: oy, width: n.width, height: n.height }
}

function collectSubtreeIds(nodes: Map<string, SceneNode>, rootId: string): Set<string> {
  const out = new Set<string>()
  const walk = (id: string): void => {
    if (out.has(id)) return
    out.add(id)
    const n = nodes.get(id)
    if (n?.type === 'group') {
      for (const c of n.childIds) walk(c)
    }
  }
  walk(rootId)
  return out
}

function isDescendant(nodes: Map<string, SceneNode>, ancestorId: string, nodeId: string): boolean {
  let cur: string | null = nodeId
  while (cur) {
    if (cur === ancestorId) return true
    cur = nodes.get(cur)?.parentId ?? null
  }
  return false
}

function unionBoundsWorld(
  ids: Iterable<string>,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
): { left: number; right: number; top: number; bottom: number; cx: number; cy: number } | null {
  let left = Infinity
  let right = -Infinity
  let top = Infinity
  let bottom = -Infinity
  for (const id of ids) {
    const f = worldFrame(nodes, definitions, id)
    if (!f) continue
    left = Math.min(left, f.x)
    right = Math.max(right, f.x + f.width)
    top = Math.min(top, f.y)
    bottom = Math.max(bottom, f.y + f.height)
  }
  if (!Number.isFinite(left)) return null
  return {
    left,
    right,
    top,
    bottom,
    cx: (left + right) / 2,
    cy: (top + bottom) / 2,
  }
}

function collectSnapTargetsX(
  exclude: Set<string>,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
): number[] {
  const t = new Set<number>()
  t.add(0)
  t.add(VIEW_W / 2)
  t.add(VIEW_W)
  for (const n of nodes.values()) {
    if (exclude.has(n.id)) continue
    const f = worldFrame(nodes, definitions, n.id)
    if (!f) continue
    t.add(f.x)
    t.add(f.x + f.width / 2)
    t.add(f.x + f.width)
  }
  return [...t]
}

function collectSnapTargetsY(
  exclude: Set<string>,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
): number[] {
  const t = new Set<number>()
  t.add(0)
  t.add(VIEW_H / 2)
  t.add(VIEW_H)
  for (const n of nodes.values()) {
    if (exclude.has(n.id)) continue
    const f = worldFrame(nodes, definitions, n.id)
    if (!f) continue
    t.add(f.y)
    t.add(f.y + f.height / 2)
    t.add(f.y + f.height)
  }
  return [...t]
}

/** Best 1D snap: align left, center, or right (or top, mid, bottom) to targets. */
function snapAxis(
  axis: 'x' | 'y',
  a0: number,
  aMid: number,
  a1: number,
  targets: number[],
  maxDist: number,
): { delta: number; guide: number | null; label: string | null } {
  const centerLine = axis === 'x' ? VIEW_W / 2 : VIEW_H / 2
  const spanMax = axis === 'x' ? VIEW_W : VIEW_H
  let best = { dist: maxDist + 1, delta: 0, guide: null as number | null, label: null as string | null }
  const tries: { val: number; kind: 'edge' | 'center' }[] = [
    { val: a0, kind: 'edge' },
    { val: aMid, kind: 'center' },
    { val: a1, kind: 'edge' },
  ]
  for (const tx of targets) {
    for (const { val, kind } of tries) {
      const delta = tx - val
      const ad = Math.abs(delta)
      if (ad <= maxDist && ad < best.dist) {
        const onCanvasMid = tx === centerLine
        const onCanvasEdge = tx === 0 || tx === spanMax
        let label: string | null = null
        if (onCanvasMid) {
          label = kind === 'center' ? 'Symmetric: aligned to canvas center' : 'Symmetric: edge to center line'
        } else if (onCanvasEdge) {
          label = 'Aligned to canvas edge'
        } else {
          label = kind === 'center' ? 'Aligned to layer center' : 'Aligned to layer edge'
        }
        best = { dist: ad, delta, guide: tx, label }
      }
    }
  }
  if (best.dist <= maxDist) return { delta: best.delta, guide: best.guide, label: best.label }
  return { delta: 0, guide: null, label: null }
}

function newId(): string {
  return crypto.randomUUID()
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function itemLabel(item: SceneNode, definitions: Map<string, ComponentDefinition>): string {
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

function buildSvgFragmentLeaf(item: SceneLeaf): string {
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

function serializeDefSubtreeSvg(def: ComponentDefinition, id: string, indent: string): string {
  const n = def.nodes[id]
  if (!n) return ''
  if (n.type === 'group') {
    const inner = n.childIds.map((cid) => serializeDefSubtreeSvg(def, cid, `${indent}  `)).join('\n')
    return `${indent}<g transform="translate(${n.x} ${n.y})">\n${inner}\n${indent}</g>`
  }
  return `${indent}${buildSvgFragmentLeaf(n)}`
}

function serializeSceneSubtreeSvg(
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

function serializeSvgFromRoots(
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

function downloadSvg(svg: string, filename: string): void {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.click()
  URL.revokeObjectURL(url)
}

const STORAGE_KEY_V2 = 'pop-studio-state-v2'
const STORAGE_KEY_V1 = 'pop-studio-state-v1'

type PersistedStateV1 = {
  v: 1
  items: CanvasItem[]
  layerNames: Record<string, string>
  defaultFill: string
  defaultStroke: string
  defaultStrokeWidth: number
  symmetryGuidesOn: boolean
  viewTx?: number
  viewTy?: number
  viewScale?: number
}

type PersistedStateV2 = {
  v: 2
  rootIds: string[]
  nodes: Record<string, SceneNode>
  layerNames: Record<string, string>
  definitions: Record<string, ComponentDefinition>
  defaultFill: string
  defaultStroke: string
  defaultStrokeWidth: number
  symmetryGuidesOn: boolean
  viewTx?: number
  viewTy?: number
  viewScale?: number
  editingComponentId?: string | null
}

function isValidCanvasItem(x: unknown): x is CanvasItem {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.type !== 'string') return false
  const n = (k: string) => typeof o[k] === 'number'
  const s = (k: string) => typeof o[k] === 'string'
  switch (o.type) {
    case 'rect':
    case 'ellipse':
      return (
        n('x') &&
        n('y') &&
        n('width') &&
        n('height') &&
        s('fill') &&
        s('stroke') &&
        typeof o.strokeWidth === 'number'
      )
    case 'text':
      return n('x') && n('y') && n('width') && n('height') && s('content') && n('fontSize') && s('fill')
    case 'image':
      return n('x') && n('y') && n('width') && n('height') && s('href')
    default:
      return false
  }
}

function isValidSceneNode(x: unknown): x is SceneNode {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.type !== 'string') return false
  const n = (k: string) => typeof o[k] === 'number'
  const s = (k: string) => typeof o[k] === 'string'
  const parentOk = o.parentId === null || typeof o.parentId === 'string'
  if (!parentOk) return false
  switch (o.type) {
    case 'group':
      return (
        n('x') &&
        n('y') &&
        n('width') &&
        n('height') &&
        Array.isArray(o.childIds) &&
        (o.childIds as unknown[]).every((c) => typeof c === 'string')
      )
    case 'instance':
      return n('x') && n('y') && n('width') && n('height') && s('componentId')
    case 'rect':
    case 'ellipse':
      return (
        n('x') &&
        n('y') &&
        n('width') &&
        n('height') &&
        s('fill') &&
        s('stroke') &&
        typeof o.strokeWidth === 'number'
      )
    case 'text':
      return n('x') && n('y') && n('width') && n('height') && s('content') && n('fontSize') && s('fill')
    case 'image':
      return n('x') && n('y') && n('width') && n('height') && s('href')
    default:
      return false
  }
}

function isValidDefNode(x: unknown): x is DefNode {
  return isValidSceneNode(x) && (x as SceneNode).type !== 'instance'
}

function isValidComponentDefinition(x: unknown): x is ComponentDefinition {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.name !== 'string') return false
  if (typeof o.rootId !== 'string') return false
  if (typeof o.intrinsicW !== 'number' || typeof o.intrinsicH !== 'number') return false
  if (!o.nodes || typeof o.nodes !== 'object') return false
  const nodes = o.nodes as Record<string, unknown>
  for (const k of Object.keys(nodes)) {
    if (!isValidDefNode(nodes[k])) return false
  }
  return true
}

function migrateV1ToScene(items: CanvasItem[]): { rootIds: string[]; nodes: Map<string, SceneNode> } {
  const nodes = new Map<string, SceneNode>()
  const rootIds = items.map((it) => {
    const base = { id: it.id, parentId: null as string | null }
    if (it.type === 'rect') {
      nodes.set(it.id, { ...base, ...it })
    } else if (it.type === 'ellipse') {
      nodes.set(it.id, { ...base, ...it })
    } else if (it.type === 'text') {
      nodes.set(it.id, { ...base, ...it })
    } else {
      nodes.set(it.id, { ...base, ...it })
    }
    return it.id
  })
  return { rootIds, nodes }
}

function recordToNodes(r: Record<string, SceneNode>): Map<string, SceneNode> {
  const m = new Map<string, SceneNode>()
  for (const k of Object.keys(r)) {
    const n = r[k]
    if (n && isValidSceneNode(n)) m.set(k, n)
  }
  return m
}

function nodesToRecord(nodes: Map<string, SceneNode>): Record<string, SceneNode> {
  const r: Record<string, SceneNode> = {}
  for (const [k, v] of nodes) r[k] = v
  return r
}

function recordToDefs(r: Record<string, ComponentDefinition>): Map<string, ComponentDefinition> {
  const m = new Map<string, ComponentDefinition>()
  for (const k of Object.keys(r)) {
    const d = r[k]
    if (d && isValidComponentDefinition(d)) m.set(k, d)
  }
  return m
}

function defsToRecord(defs: Map<string, ComponentDefinition>): Record<string, ComponentDefinition> {
  const r: Record<string, ComponentDefinition> = {}
  for (const [k, v] of defs) r[k] = v
  return r
}

export function mount(root: HTMLElement): void {
  let rootIds: string[] = []
  let nodes = new Map<string, SceneNode>()
  let definitions = new Map<string, ComponentDefinition>()
  /** When set, canvas shows definition tree for editing the main component. */
  let editingComponentId: string | null = null
  let mainNodesBackup: Map<string, SceneNode> | null = null
  let mainRootIdsBackup: string[] | null = null
  /** Custom layer names by item id; when missing, UI falls back to `itemLabel`. */
  let layerNames: Record<string, string> = {}
  let selected = new Set<string>()
  let tool: Tool = 'select'
  let defaultFill = '#3b82f6'
  let defaultStroke = '#1e3a5f'
  let defaultStrokeWidth = 2
  let symmetryGuidesOn = true
  let propsPanelFocused = false
  let lastSnapHint: string | null = null
  let viewTx = 0
  let viewTy = 0
  let viewScale = 1

  const dragState: {
    active: boolean
    pointerId: number | null
    startSvgX: number
    startSvgY: number
    origins: Map<string, { x: number; y: number }>
  } = {
    active: false,
    pointerId: null,
    startSvgX: 0,
    startSvgY: 0,
    origins: new Map(),
  }

  const resizeState: {
    active: boolean
    pointerId: number | null
    handle: ResizeHandleId | null
    itemId: string | null
    start: { x: number; y: number; width: number; height: number }
    startFontSize: number | undefined
  } = {
    active: false,
    pointerId: null,
    handle: null,
    itemId: null,
    start: { x: 0, y: 0, width: 0, height: 0 },
    startFontSize: undefined,
  }

  root.innerHTML = `
    <div class="pop-app">
      <header class="pop-header">
        <h1 class="pop-title">Pop</h1>
        <p class="pop-sub">Draw on the canvas, add images, then export SVG. Raster images become <code>&lt;image&gt;</code> in the SVG (embedded), not auto-traced vectors.</p>
      </header>
      <div class="pop-toolbar">
        <span class="pop-label">Tool</span>
        <div class="pop-tools" role="group" aria-label="Tools">
          <button type="button" class="pop-btn pop-tool" data-tool="select" aria-pressed="true">Select</button>
          <button type="button" class="pop-btn pop-tool" data-tool="rect" aria-pressed="false">Rectangle</button>
          <button type="button" class="pop-btn pop-tool" data-tool="ellipse" aria-pressed="false">Ellipse</button>
          <button type="button" class="pop-btn pop-tool" data-tool="text" aria-pressed="false">Text</button>
          <button type="button" class="pop-btn pop-tool" data-tool="image" aria-pressed="false">Image</button>
        </div>
        <span class="pop-sep"></span>
        <span class="pop-label">Zoom</span>
        <div class="pop-zoom" role="group" aria-label="Canvas zoom">
          <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-out" aria-label="Zoom out">−</button>
          <span class="pop-zoom-pct" id="pop-zoom-pct" aria-live="polite">100%</span>
          <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-in" aria-label="Zoom in">+</button>
          <button type="button" class="pop-btn" id="pop-zoom-reset" title="Reset zoom and pan to 100%">Reset view</button>
        </div>
        <span class="pop-sep"></span>
        <div class="pop-color-field">
          <span class="pop-color-field-lbl">Fill</span>
          <div class="pop-color-picker">
            <button type="button" class="pop-color-swatch" id="pop-fill-swatch" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop-fill-panel" title="Fill color"></button>
            <input type="color" class="pop-color-native" id="pop-fill" value="#3b82f6" tabindex="-1" />
            <div class="pop-color-panel" id="pop-fill-panel" role="dialog" aria-label="Fill color palette" hidden>
              <div class="pop-color-panel-cap">Theme colors</div>
              <div class="pop-color-grid pop-color-grid-theme" id="pop-fill-theme"></div>
              <div class="pop-color-panel-cap">Standard colors</div>
              <div class="pop-color-grid pop-color-grid-standard" id="pop-fill-standard"></div>
              <button type="button" class="pop-btn pop-color-more" id="pop-fill-more">More colors…</button>
            </div>
          </div>
        </div>
        <div class="pop-color-field">
          <span class="pop-color-field-lbl">Stroke</span>
          <div class="pop-color-picker">
            <button type="button" class="pop-color-swatch" id="pop-stroke-swatch" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop-stroke-panel" title="Stroke color"></button>
            <input type="color" class="pop-color-native" id="pop-stroke" value="#1e3a5f" tabindex="-1" />
            <div class="pop-color-panel" id="pop-stroke-panel" role="dialog" aria-label="Stroke color palette" hidden>
              <div class="pop-color-panel-cap">Theme colors</div>
              <div class="pop-color-grid pop-color-grid-theme" id="pop-stroke-theme"></div>
              <div class="pop-color-panel-cap">Standard colors</div>
              <div class="pop-color-grid pop-color-grid-standard" id="pop-stroke-standard"></div>
              <button type="button" class="pop-btn pop-color-more" id="pop-stroke-more">More colors…</button>
            </div>
          </div>
        </div>
        <label class="pop-stroke-w">Width <input type="range" id="pop-stroke-w" min="0" max="12" value="2"/></label>
        <span class="pop-sep"></span>
        <button type="button" class="pop-btn pop-primary" id="pop-export-sel">Download selected as SVG</button>
        <button type="button" class="pop-btn" id="pop-export-all">Download full canvas</button>
        <button type="button" class="pop-btn pop-danger" id="pop-delete" disabled>Delete</button>
        <span class="pop-sep"></span>
        <button type="button" class="pop-btn" id="pop-group" disabled>Group</button>
        <button type="button" class="pop-btn" id="pop-ungroup" disabled>Ungroup</button>
        <span class="pop-sep"></span>
        <button type="button" class="pop-btn" id="pop-create-comp" disabled>Create component</button>
        <button type="button" class="pop-btn" id="pop-detach" disabled>Detach instance</button>
        <button type="button" class="pop-btn" id="pop-edit-comp" disabled>Edit main</button>
        <label class="pop-comp-insert">
          <span class="pop-label">Insert</span>
          <select id="pop-comp-pick" class="pop-comp-pick" aria-label="Component to insert"></select>
          <button type="button" class="pop-btn" id="pop-insert-inst">Instance</button>
        </label>
        <input type="file" id="pop-file" accept="image/*" hidden />
      </div>
      <div class="pop-comp-banner" id="pop-comp-banner" hidden>
        <span id="pop-comp-banner-text"></span>
        <button type="button" class="pop-btn pop-primary" id="pop-comp-done">Done editing</button>
      </div>
      <div class="pop-main">
        <aside class="pop-layers" aria-label="Layers and transform">
          <h2>Layers</h2>
          <ul class="pop-layer-list" id="pop-layers" data-pop-layer-tree></ul>
          <div class="pop-props">
            <h2>Transform</h2>
            <div class="pop-prop-grid" id="pop-prop-grid">
              <label class="pop-field"><span class="pop-field-lbl">X</span><input type="number" id="pop-px" class="pop-num" step="1" disabled /></label>
              <label class="pop-field"><span class="pop-field-lbl">Y</span><input type="number" id="pop-py" class="pop-num" step="1" disabled /></label>
              <label class="pop-field" id="pop-pw-wrap"><span class="pop-field-lbl">W</span><input type="number" id="pop-pw" class="pop-num" step="1" min="1" disabled /></label>
              <label class="pop-field" id="pop-ph-wrap"><span class="pop-field-lbl">H</span><input type="number" id="pop-ph" class="pop-num" step="1" min="1" disabled /></label>
            </div>
            <label class="pop-field pop-field-fs" id="pop-fs-wrap"><span class="pop-field-lbl">Font size</span><input type="number" id="pop-pfs" class="pop-num" step="1" min="4" max="400" disabled /></label>
            <div class="pop-symmetry">
              <label class="pop-check"><input type="checkbox" id="pop-guides" checked /><span>Symmetry guides &amp; snap</span></label>
              <p class="pop-hint" id="pop-sym-hint"></p>
            </div>
          </div>
        </aside>
        <div class="pop-canvas-wrap" title="Ctrl or ⌘ + scroll (or trackpad pinch) to zoom toward the pointer">
          <svg class="pop-canvas" id="pop-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}" role="img" aria-label="Design canvas">
            <defs>
              <pattern id="pop-grid" width="16" height="16" patternUnits="userSpaceOnUse">
                <rect width="16" height="16" fill="var(--canvas-cell)"/>
                <path d="M 16 0 L 0 0 0 16" fill="none" stroke="var(--canvas-line)" stroke-width="0.5"/>
              </pattern>
            </defs>
            <rect class="pop-canvas-bg" x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" fill="url(#pop-grid)" pointer-events="none"/>
            <g id="pop-viewport" transform="translate(0 0) scale(1)">
              <g id="pop-guides-back" pointer-events="none"></g>
              <g id="pop-items"></g>
              <g id="pop-handles"></g>
              <g id="pop-guides-front" pointer-events="none"></g>
            </g>
          </svg>
        </div>
      </div>
    </div>
  `

  const svg = root.querySelector<SVGSVGElement>('#pop-svg')!
  const viewportG = root.querySelector<SVGGElement>('#pop-viewport')!
  const canvasWrap = root.querySelector<HTMLElement>('.pop-canvas-wrap')!
  const itemsG = root.querySelector<SVGGElement>('#pop-items')!
  const handlesG = root.querySelector<SVGGElement>('#pop-handles')!
  const layerList = root.querySelector<HTMLUListElement>('#pop-layers')!
  const fileInput = root.querySelector<HTMLInputElement>('#pop-file')!
  const fillInput = root.querySelector<HTMLInputElement>('#pop-fill')!
  const strokeInput = root.querySelector<HTMLInputElement>('#pop-stroke')!
  const strokeWInput = root.querySelector<HTMLInputElement>('#pop-stroke-w')!
  const btnExportSel = root.querySelector<HTMLButtonElement>('#pop-export-sel')!
  const btnExportAll = root.querySelector<HTMLButtonElement>('#pop-export-all')!
  const btnDelete = root.querySelector<HTMLButtonElement>('#pop-delete')!
  const btnGroup = root.querySelector<HTMLButtonElement>('#pop-group')!
  const btnUngroup = root.querySelector<HTMLButtonElement>('#pop-ungroup')!
  const btnCreateComp = root.querySelector<HTMLButtonElement>('#pop-create-comp')!
  const btnDetach = root.querySelector<HTMLButtonElement>('#pop-detach')!
  const btnEditComp = root.querySelector<HTMLButtonElement>('#pop-edit-comp')!
  const selCompPick = root.querySelector<HTMLSelectElement>('#pop-comp-pick')!
  const btnInsertInst = root.querySelector<HTMLButtonElement>('#pop-insert-inst')!
  const compBanner = root.querySelector<HTMLElement>('#pop-comp-banner')!
  const compBannerText = root.querySelector<HTMLElement>('#pop-comp-banner-text')!
  const btnCompDone = root.querySelector<HTMLButtonElement>('#pop-comp-done')!
  const toolButtons = root.querySelectorAll<HTMLButtonElement>('.pop-tool')
  const guidesBack = root.querySelector<SVGGElement>('#pop-guides-back')!
  const guidesFront = root.querySelector<SVGGElement>('#pop-guides-front')!
  const guidesCheckbox = root.querySelector<HTMLInputElement>('#pop-guides')!
  const symHint = root.querySelector<HTMLParagraphElement>('#pop-sym-hint')!
  const inpX = root.querySelector<HTMLInputElement>('#pop-px')!
  const inpY = root.querySelector<HTMLInputElement>('#pop-py')!
  const inpW = root.querySelector<HTMLInputElement>('#pop-pw')!
  const inpH = root.querySelector<HTMLInputElement>('#pop-ph')!
  const inpFs = root.querySelector<HTMLInputElement>('#pop-pfs')!
  const fsWrap = root.querySelector<HTMLElement>('#pop-fs-wrap')!
  const pwWrap = root.querySelector<HTMLElement>('#pop-pw-wrap')!
  const phWrap = root.querySelector<HTMLElement>('#pop-ph-wrap')!

  const fillSwatch = root.querySelector<HTMLButtonElement>('#pop-fill-swatch')!
  const strokeSwatch = root.querySelector<HTMLButtonElement>('#pop-stroke-swatch')!
  const fillPanel = root.querySelector<HTMLElement>('#pop-fill-panel')!
  const strokePanel = root.querySelector<HTMLElement>('#pop-stroke-panel')!
  const fillThemeHost = root.querySelector<HTMLElement>('#pop-fill-theme')!
  const fillStandardHost = root.querySelector<HTMLElement>('#pop-fill-standard')!
  const strokeThemeHost = root.querySelector<HTMLElement>('#pop-stroke-theme')!
  const strokeStandardHost = root.querySelector<HTMLElement>('#pop-stroke-standard')!
  const fillMoreBtn = root.querySelector<HTMLButtonElement>('#pop-fill-more')!
  const strokeMoreBtn = root.querySelector<HTMLButtonElement>('#pop-stroke-more')!
  const btnZoomIn = root.querySelector<HTMLButtonElement>('#pop-zoom-in')!
  const btnZoomOut = root.querySelector<HTMLButtonElement>('#pop-zoom-out')!
  const btnZoomReset = root.querySelector<HTMLButtonElement>('#pop-zoom-reset')!
  const elZoomPct = root.querySelector<HTMLElement>('#pop-zoom-pct')!

  function updateFillSwatch(): void {
    fillSwatch.style.backgroundColor = fillInput.value
    fillSwatch.title = `Fill: ${fillInput.value}`
  }

  function updateStrokeSwatch(): void {
    strokeSwatch.style.backgroundColor = strokeInput.value
    strokeSwatch.title = `Stroke: ${strokeInput.value}`
  }

  function updateBothSwatches(): void {
    updateFillSwatch()
    updateStrokeSwatch()
  }

  let openColorPicker: { panel: HTMLElement; swatch: HTMLButtonElement } | null = null

  function closeColorPickerPanel(): void {
    if (!openColorPicker) return
    openColorPicker.panel.hidden = true
    openColorPicker.swatch.setAttribute('aria-expanded', 'false')
    openColorPicker = null
  }

  function positionColorPanel(panel: HTMLElement, swatch: HTMLButtonElement): void {
    panel.style.position = 'fixed'
    panel.style.zIndex = '2000'
    const r = swatch.getBoundingClientRect()
    const margin = 8
    const pw = panel.offsetWidth
    const ph = panel.offsetHeight
    let left = r.left
    let top = r.bottom + margin
    if (left + pw > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - pw - margin)
    }
    if (left < margin) left = margin
    if (top + ph > window.innerHeight - margin) {
      top = Math.max(margin, r.top - ph - margin)
    }
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }

  function toggleColorPickerPanel(panel: HTMLElement, swatch: HTMLButtonElement): void {
    if (openColorPicker?.panel === panel) {
      closeColorPickerPanel()
      return
    }
    closeColorPickerPanel()
    panel.hidden = false
    swatch.setAttribute('aria-expanded', 'true')
    openColorPicker = { panel, swatch }
    requestAnimationFrame(() => {
      positionColorPanel(panel, swatch)
      requestAnimationFrame(() => positionColorPanel(panel, swatch))
    })
  }

  function populateColorCells(host: HTMLElement, colors: string[], input: HTMLInputElement): void {
    host.replaceChildren()
    for (const raw of colors) {
      const hex = normalizeHex6(raw)
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'pop-color-cell'
      cell.style.backgroundColor = hex
      cell.title = hex
      cell.setAttribute('aria-label', `Use color ${hex}`)
      cell.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        input.value = hex
        input.dispatchEvent(new Event('input', { bubbles: true }))
        closeColorPickerPanel()
      })
      host.appendChild(cell)
    }
  }

  const themeSwatches = buildExcelThemeGrid().flat()
  populateColorCells(fillThemeHost, themeSwatches, fillInput)
  populateColorCells(fillStandardHost, EXCEL_STANDARD_COLORS, fillInput)
  populateColorCells(strokeThemeHost, themeSwatches, strokeInput)
  populateColorCells(strokeStandardHost, EXCEL_STANDARD_COLORS, strokeInput)

  fillSwatch.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggleColorPickerPanel(fillPanel, fillSwatch)
  })
  strokeSwatch.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    toggleColorPickerPanel(strokePanel, strokeSwatch)
  })

  fillMoreBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    closeColorPickerPanel()
    fillInput.showPicker?.() ?? fillInput.click()
  })
  strokeMoreBtn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    closeColorPickerPanel()
    strokeInput.showPicker?.() ?? strokeInput.click()
  })

  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (!openColorPicker) return
      const t = ev.target as Node
      if (openColorPicker.panel.contains(t) || openColorPicker.swatch.contains(t)) return
      closeColorPickerPanel()
    },
    true,
  )

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeColorPickerPanel()
  })

  window.addEventListener('resize', () => closeColorPickerPanel())
  window.addEventListener(
    'scroll',
    () => closeColorPickerPanel(),
    true,
  )

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function syncViewportTransform(): void {
    viewportG.setAttribute('transform', `translate(${viewTx} ${viewTy}) scale(${viewScale})`)
  }

  function updateZoomPctLabel(): void {
    elZoomPct.textContent = `${Math.round(viewScale * 100)}%`
  }

  /** Change scale while keeping the given canvas point (world coords) under the cursor. */
  function zoomAtWorldPoint(wx: number, wy: number, newScale: number): void {
    const ns = clamp(newScale, MIN_VIEW_SCALE, MAX_VIEW_SCALE)
    viewTx += wx * (viewScale - ns)
    viewTy += wy * (viewScale - ns)
    viewScale = ns
    syncViewportTransform()
    updateZoomPctLabel()
    schedulePersist()
  }

  function clientToSvgCoords(clientX: number, clientY: number): { x: number; y: number } {
    const pt = svg.createSVGPoint()
    pt.x = clientX
    pt.y = clientY
    const ctm = svg.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = pt.matrixTransform(ctm.inverse())
    return {
      x: (p.x - viewTx) / viewScale,
      y: (p.y - viewTy) / viewScale,
    }
  }

  function persistToStorage(): void {
    try {
      const payload: PersistedStateV2 = {
        v: 2,
        rootIds: [...rootIds],
        nodes: nodesToRecord(nodes),
        layerNames: { ...layerNames },
        definitions: defsToRecord(definitions),
        defaultFill,
        defaultStroke,
        defaultStrokeWidth,
        symmetryGuidesOn,
        viewTx,
        viewTy,
        viewScale,
        editingComponentId,
      }
      localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(payload))
    } catch {
      /* quota or private mode */
    }
  }

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistToStorage()
    }, 160)
  }

  function applyLoadedView(data: {
    defaultFill?: string
    defaultStroke?: string
    defaultStrokeWidth?: number
    symmetryGuidesOn?: boolean
    viewTx?: number
    viewTy?: number
    viewScale?: number
  }): void {
    if (typeof data.defaultFill === 'string') {
      defaultFill = data.defaultFill
      fillInput.value = defaultFill
    }
    if (typeof data.defaultStroke === 'string') {
      defaultStroke = data.defaultStroke
      strokeInput.value = defaultStroke
    }
    if (typeof data.defaultStrokeWidth === 'number' && Number.isFinite(data.defaultStrokeWidth)) {
      defaultStrokeWidth = clamp(Math.round(data.defaultStrokeWidth), 0, 12)
      strokeWInput.value = String(defaultStrokeWidth)
    }
    if (typeof data.symmetryGuidesOn === 'boolean') {
      symmetryGuidesOn = data.symmetryGuidesOn
      guidesCheckbox.checked = symmetryGuidesOn
    }
    if (
      typeof data.viewTx === 'number' &&
      Number.isFinite(data.viewTx) &&
      typeof data.viewTy === 'number' &&
      Number.isFinite(data.viewTy) &&
      typeof data.viewScale === 'number' &&
      Number.isFinite(data.viewScale)
    ) {
      viewTx = data.viewTx
      viewTy = data.viewTy
      viewScale = clamp(data.viewScale, MIN_VIEW_SCALE, MAX_VIEW_SCALE)
    }
  }

  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2)
    if (rawV2) {
      const data = JSON.parse(rawV2) as Partial<PersistedStateV2>
      if (data.v === 2 && data.nodes && typeof data.nodes === 'object' && Array.isArray(data.rootIds)) {
        nodes = recordToNodes(data.nodes as Record<string, SceneNode>)
        rootIds = data.rootIds.filter((id) => nodes.has(id))
        if (data.definitions && typeof data.definitions === 'object') {
          definitions = recordToDefs(data.definitions as Record<string, ComponentDefinition>)
        }
        if (data.layerNames && typeof data.layerNames === 'object') {
          layerNames = { ...data.layerNames }
        }
        editingComponentId =
          typeof data.editingComponentId === 'string' ? data.editingComponentId : null
        const keepIds = new Set(nodes.keys())
        for (const k of Object.keys(layerNames)) {
          if (!keepIds.has(k)) delete layerNames[k]
        }
        applyLoadedView(data)
      }
    } else {
      const rawV1 = localStorage.getItem(STORAGE_KEY_V1)
      if (rawV1) {
        const data = JSON.parse(rawV1) as Partial<PersistedStateV1>
        if (data.v === 1 && Array.isArray(data.items)) {
          const next = data.items.filter(isValidCanvasItem)
          const mig = migrateV1ToScene(next)
          rootIds = mig.rootIds
          nodes = mig.nodes
          if (data.layerNames && typeof data.layerNames === 'object') {
            layerNames = { ...data.layerNames }
          }
          const ids = new Set(nodes.keys())
          for (const k of Object.keys(layerNames)) {
            if (!ids.has(k)) delete layerNames[k]
          }
          applyLoadedView(data)
        }
      }
    }
  } catch {
    /* ignore corrupt storage */
  }

  updateBothSwatches()

  let hintTimer: ReturnType<typeof setTimeout> | null = null

  function setBaseSymHint(): void {
    if (!symmetryGuidesOn) {
      symHint.textContent = 'Turn on for center lines and magnetic snapping while you drag.'
      return
    }
    symHint.textContent = `Center lines mark the canvas midpoint. While dragging, Pop snaps within ${SNAP_PX}px to those lines, canvas edges, and other layers.`
  }

  function flashSnapHint(msg: string): void {
    symHint.textContent = msg
    if (hintTimer) clearTimeout(hintTimer)
    hintTimer = setTimeout(() => {
      hintTimer = null
      setBaseSymHint()
    }, 2600)
  }

  function readNum(el: HTMLInputElement): number | null {
    const v = parseFloat(el.value)
    return Number.isFinite(v) ? v : null
  }

  function syncPropsFromSelection(): void {
    const n = selected.size
    inpX.disabled = n !== 1
    inpY.disabled = n !== 1
    inpW.disabled = n === 0
    inpH.disabled = n === 0

    if (n === 0) {
      inpFs.disabled = true
      inpX.value = ''
      inpY.value = ''
      inpW.value = ''
      inpH.value = ''
      inpFs.value = ''
      fsWrap.style.display = 'none'
      pwWrap.style.display = ''
      phWrap.style.display = ''
      return
    }

    if (n === 1) {
      const it = getItemById([...selected][0]!)!
      inpX.value = String(stripNum(it.x))
      inpY.value = String(stripNum(it.y))
      if (it.type === 'text') {
        inpFs.disabled = false
        fsWrap.style.display = 'flex'
        pwWrap.style.display = 'none'
        phWrap.style.display = 'none'
        inpFs.value = String(stripNum(it.fontSize))
        inpW.value = ''
        inpH.value = ''
      } else {
        inpFs.disabled = true
        fsWrap.style.display = 'none'
        pwWrap.style.display = ''
        phWrap.style.display = ''
        inpW.value = String(stripNum(it.width))
        inpH.value = String(stripNum(it.height))
        inpFs.value = ''
      }
      return
    }

    inpFs.disabled = true
    fsWrap.style.display = 'none'
    pwWrap.style.display = ''
    phWrap.style.display = ''
    inpX.value = ''
    inpY.value = ''
    inpFs.value = ''
    const ws = [...selected].map((id) => getItemById(id)!.width)
    const hs = [...selected].map((id) => getItemById(id)!.height)
    inpW.value = ws.every((w) => w === ws[0]) ? String(stripNum(ws[0]!)) : ''
    inpH.value = hs.every((h) => h === hs[0]) ? String(stripNum(hs[0]!)) : ''
  }

  function stripNum(n: number): number {
    return Math.round(n * 1000) / 1000
  }

  function applyTransformFromInputs(): void {
    if (selected.size === 0) return
    if (selected.size === 1) {
      const it = getItemById([...selected][0]!)!
      const px = readNum(inpX)
      const py = readNum(inpY)
      if (px !== null) it.x = px
      if (py !== null) it.y = py
      if (it.type === 'text') {
        const pfs = readNum(inpFs)
        if (pfs !== null) {
          it.fontSize = clamp(pfs, 4, 400)
          it.height = it.fontSize
        }
      } else {
        const pw = readNum(inpW)
        const ph = readNum(inpH)
        if (pw !== null) it.width = Math.max(1, pw)
        if (ph !== null) it.height = Math.max(1, ph)
      }
    } else {
      const pw = readNum(inpW)
      const ph = readNum(inpH)
      if (pw !== null) {
        for (const id of selected) {
          const it = getItemById(id)
          if (it) it.width = Math.max(1, pw)
        }
      }
      if (ph !== null) {
        for (const id of selected) {
          const it = getItemById(id)
          if (it) it.height = Math.max(1, ph)
        }
      }
    }
    commit()
  }

  function renderStaticGuides(): void {
    guidesBack.replaceChildren()
    if (!symmetryGuidesOn) return
    const mkLine = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
    ): SVGLineElement => {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      l.setAttribute('x1', String(x1))
      l.setAttribute('y1', String(y1))
      l.setAttribute('x2', String(x2))
      l.setAttribute('y2', String(y2))
      l.setAttribute('stroke', '#7c9cff')
      l.setAttribute('stroke-opacity', '0.35')
      l.setAttribute('stroke-width', '1')
      l.setAttribute('stroke-dasharray', '8 6')
      l.setAttribute('vector-effect', 'non-scaling-stroke')
      return l
    }
    guidesBack.appendChild(mkLine(VIEW_W / 2, 0, VIEW_W / 2, VIEW_H))
    guidesBack.appendChild(mkLine(0, VIEW_H / 2, VIEW_W, VIEW_H / 2))
  }

  function renderSnapGuides(verticalX: number | null, horizontalY: number | null): void {
    guidesFront.replaceChildren()
    if (verticalX !== null) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      l.setAttribute('x1', String(verticalX))
      l.setAttribute('x2', String(verticalX))
      l.setAttribute('y1', '0')
      l.setAttribute('y2', String(VIEW_H))
      l.setAttribute('stroke', '#c4d0ff')
      l.setAttribute('stroke-width', '1.5')
      l.setAttribute('vector-effect', 'non-scaling-stroke')
      guidesFront.appendChild(l)
    }
    if (horizontalY !== null) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      l.setAttribute('x1', '0')
      l.setAttribute('x2', String(VIEW_W))
      l.setAttribute('y1', String(horizontalY))
      l.setAttribute('y2', String(horizontalY))
      l.setAttribute('stroke', '#c4d0ff')
      l.setAttribute('stroke-width', '1.5')
      l.setAttribute('vector-effect', 'non-scaling-stroke')
      guidesFront.appendChild(l)
    }
  }

  for (const el of [inpX, inpY, inpW, inpH, inpFs]) {
    el.addEventListener('focus', () => {
      propsPanelFocused = true
    })
    el.addEventListener('blur', () => {
      propsPanelFocused = false
      syncPropsFromSelection()
    })
    el.addEventListener('input', () => applyTransformFromInputs())
  }

  guidesCheckbox.addEventListener('change', () => {
    symmetryGuidesOn = guidesCheckbox.checked
    renderStaticGuides()
    guidesFront.replaceChildren()
    if (hintTimer) {
      clearTimeout(hintTimer)
      hintTimer = null
    }
    setBaseSymHint()
    schedulePersist()
  })

  function syncChromeFromInputs(): void {
    defaultFill = fillInput.value
    defaultStroke = strokeInput.value
    defaultStrokeWidth = Number(strokeWInput.value)
  }

  function setTool(next: Tool): void {
    tool = next
    toolButtons.forEach((b) => {
      const t = b.dataset.tool as Tool
      const on = t === tool
      b.classList.toggle('pop-tool-active', on)
      b.setAttribute('aria-pressed', String(on))
    })
    svg.classList.toggle('pop-canvas-draw', tool !== 'select')
    if (tool === 'image') {
      fileInput.click()
      setTool('select')
    }
    renderHandles()
  }

  function getNode(id: string): SceneNode | undefined {
    return nodes.get(id)
  }

  function removeChildRef(parentId: string | null, childId: string): void {
    if (parentId === null) {
      rootIds = rootIds.filter((id) => id !== childId)
    } else {
      const p = nodes.get(parentId)
      if (p?.type === 'group') {
        p.childIds = p.childIds.filter((id) => id !== childId)
      }
    }
  }

  function insertChildRef(parentId: string | null, childId: string, index: number): void {
    const child = nodes.get(childId)
    if (!child) return
    removeChildRef(child.parentId, childId)
    child.parentId = parentId
    if (parentId === null) {
      const i = clamp(index, 0, rootIds.length)
      rootIds.splice(i, 0, childId)
    } else {
      const p = nodes.get(parentId)
      if (p?.type === 'group') {
        const i = clamp(index, 0, p.childIds.length)
        const next = [...p.childIds]
        next.splice(i, 0, childId)
        p.childIds = next
      }
    }
  }

  function selectedDeletionRoots(): string[] {
    const sel = [...selected]
    return sel.filter(
      (id) => !sel.some((o) => o !== id && isDescendant(nodes, o, id)),
    )
  }

  function deleteNodesSubtrees(ids: Iterable<string>): void {
    for (const id of ids) {
      const n = nodes.get(id)
      if (!n) continue
      removeChildRef(n.parentId, id)
      for (const x of collectSubtreeIds(nodes, id)) {
        nodes.delete(x)
        delete layerNames[x]
        selected.delete(x)
      }
    }
  }

  function defSubtreeBounds(
    def: ComponentDefinition,
    id: string,
    ox: number,
    oy: number,
  ): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const n = def.nodes[id]
    if (!n) return null
    if (n.type === 'group') {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      const gx = ox + n.x
      const gy = oy + n.y
      for (const cid of n.childIds) {
        const b = defSubtreeBounds(def, cid, gx, gy)
        if (b) {
          minX = Math.min(minX, b.minX)
          minY = Math.min(minY, b.minY)
          maxX = Math.max(maxX, b.maxX)
          maxY = Math.max(maxY, b.maxY)
        }
      }
      if (!Number.isFinite(minX)) {
        return { minX: gx, minY: gy, maxX: gx + n.width, maxY: gy + n.height }
      }
      return { minX, minY, maxX, maxY }
    }
    const lx = ox + n.x
    const ly = oy + n.y
    return { minX: lx, minY: ly, maxX: lx + n.width, maxY: ly + n.height }
  }

  function normalizeDefinitionOrigin(def: ComponentDefinition): void {
    const b = defSubtreeBounds(def, def.rootId, 0, 0)
    if (!b) return
    const dx = -b.minX
    const dy = -b.minY
    const root = def.nodes[def.rootId]
    if (root) {
      root.x += dx
      root.y += dy
    }
    def.intrinsicW = Math.max(MIN_ITEM_SIZE, b.maxX - b.minX)
    def.intrinsicH = Math.max(MIN_ITEM_SIZE, b.maxY - b.minY)
  }

  function recomputeIntrinsic(def: ComponentDefinition): void {
    const b = defSubtreeBounds(def, def.rootId, 0, 0)
    if (!b) {
      def.intrinsicW = 100
      def.intrinsicH = 100
      return
    }
    def.intrinsicW = Math.max(MIN_ITEM_SIZE, b.maxX - b.minX)
    def.intrinsicH = Math.max(MIN_ITEM_SIZE, b.maxY - b.minY)
  }

  function hitTestWorld(wx: number, wy: number): string | null {
    for (let ri = rootIds.length - 1; ri >= 0; ri--) {
      const h = hitNode(wx, wy, rootIds[ri]!, nodes)
      if (h) return h
    }
    return null
  }

  function hitNode(plx: number, ply: number, id: string, nodeMap: Map<string, SceneNode>): string | null {
    const n = nodeMap.get(id)
    if (!n) return null
    if (n.type === 'group') {
      const lx = plx - n.x
      const ly = ply - n.y
      for (let i = n.childIds.length - 1; i >= 0; i--) {
        const h = hitNode(lx, ly, n.childIds[i]!, nodeMap)
        if (h) return h
      }
      return null
    }
    if (plx < n.x || plx > n.x + n.width || ply < n.y || ply > n.y + n.height) return null
    return id
  }

  function updateCompPickList(): void {
    selCompPick.replaceChildren()
    const opt0 = document.createElement('option')
    opt0.value = ''
    opt0.textContent = definitions.size === 0 ? 'No components' : 'Pick…'
    selCompPick.appendChild(opt0)
    for (const d of definitions.values()) {
      const o = document.createElement('option')
      o.value = d.id
      o.textContent = d.name
      selCompPick.appendChild(o)
    }
    btnInsertInst.disabled = definitions.size === 0 || selCompPick.value === ''
  }

  function updateComponentBanner(): void {
    if (editingComponentId) {
      const d = definitions.get(editingComponentId)
      compBanner.hidden = false
      compBannerText.textContent = d
        ? `Editing main component: ${d.name}`
        : 'Editing component'
    } else {
      compBanner.hidden = true
    }
  }

  function enterComponentEdit(compId: string): void {
    const d = definitions.get(compId)
    if (!d) return
    mainNodesBackup = new Map(nodes)
    mainRootIdsBackup = [...rootIds]
    nodes = recordToNodes({ ...d.nodes } as Record<string, SceneNode>)
    rootIds = [d.rootId]
    editingComponentId = compId
    selected.clear()
    updateComponentBanner()
    commit()
  }

  function exitComponentEdit(save: boolean): void {
    if (!editingComponentId || !mainNodesBackup || !mainRootIdsBackup) {
      editingComponentId = null
      mainNodesBackup = null
      mainRootIdsBackup = null
      updateComponentBanner()
      return
    }
    const compId = editingComponentId
    if (save) {
      const d = definitions.get(compId)
      if (d) {
        d.nodes = nodesToRecord(nodes) as Record<string, DefNode>
        normalizeDefinitionOrigin(d)
      }
    }
    nodes = mainNodesBackup
    rootIds = mainRootIdsBackup
    mainNodesBackup = null
    mainRootIdsBackup = null
    editingComponentId = null
    updateComponentBanner()
    commit()
  }

  function updateHierarchyButtons(): void {
    const n = selected.size
    const one = n === 1 ? getNode([...selected][0]!) : undefined
    btnGroup.disabled = n < 2 || editingComponentId !== null
    btnUngroup.disabled = one?.type !== 'group' || one.childIds.length === 0 || editingComponentId !== null
    const canComp =
      n >= 1 &&
      editingComponentId === null &&
      [...selected].every((id) => getNode(id)?.type !== 'instance')
    btnCreateComp.disabled = !canComp
    btnDetach.disabled = one?.type !== 'instance' || editingComponentId !== null
    btnEditComp.disabled = one?.type !== 'instance' || editingComponentId !== null
  }

  function updateSelectionUi(): void {
    btnDelete.disabled = selected.size === 0
    updateHierarchyButtons()
    layerList.querySelectorAll<HTMLLIElement>('.pop-layer').forEach((li) => {
      const id = li.dataset.id
      if (!id) return
      li.classList.toggle('pop-layer-selected', selected.has(id))
    })
    itemsG.querySelectorAll<SVGGElement>('.pop-item').forEach((g) => {
      const id = g.dataset.id
      if (!id) return
      g.classList.toggle('pop-item-selected', selected.has(id))
    })
  }

  function pruneLayerNames(): void {
    const ids = new Set(nodes.keys())
    for (const k of Object.keys(layerNames)) {
      if (!ids.has(k)) delete layerNames[k]
    }
  }

  let layerDragId: string | null = null
  let layerDropTargetId: string | null = null
  let layerDropKind: 'before' | 'into' | null = null

  function siblingListForParent(parentId: string | null): string[] {
    if (parentId === null) return rootIds
    const p = nodes.get(parentId)
    return p?.type === 'group' ? p.childIds : []
  }

  function indexInParent(childId: string): { parentId: string | null; index: number } | null {
    const n = nodes.get(childId)
    if (!n) return null
    const list = siblingListForParent(n.parentId)
    const idx = list.indexOf(childId)
    if (idx < 0) return null
    return { parentId: n.parentId, index: idx }
  }

  function moveLayerNode(
    dragId: string,
    targetId: string,
    kind: 'before' | 'into',
  ): void {
    if (dragId === targetId) return
    if (kind === 'into' && isDescendant(nodes, dragId, targetId)) return
    const info = indexInParent(dragId)
    if (!info) return
    removeChildRef(info.parentId, dragId)
    if (kind === 'into') {
      const t = nodes.get(targetId)
      if (t?.type !== 'group') return
      const n = nodes.get(dragId)
      if (!n) return
      n.parentId = targetId
      t.childIds.push(dragId)
      return
    }
    const tInfo = indexInParent(targetId)
    if (!tInfo) return
    const n = nodes.get(dragId)
    if (!n) return
    let insertIdx = tInfo.index
    if (tInfo.parentId === info.parentId && info.index < tInfo.index) insertIdx -= 1
    n.parentId = tInfo.parentId
    if (tInfo.parentId === null) {
      rootIds.splice(insertIdx, 0, dragId)
    } else {
      const p = nodes.get(tInfo.parentId)
      if (p?.type === 'group') {
        const next = [...p.childIds]
        next.splice(insertIdx, 0, dragId)
        p.childIds = next
      }
    }
  }

  function renderLayerBranch(host: HTMLUListElement, parentId: string | null, depth: number): void {
    const ids = siblingListForParent(parentId)
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i]!
      const item = nodes.get(id)
      if (!item) continue
      const li = document.createElement('li')
      li.className = 'pop-layer'
      li.dataset.id = id
      li.dataset.depth = String(depth)
      li.style.setProperty('--pop-layer-depth', String(depth))

      const row = document.createElement('div')
      row.className = 'pop-layer-row'

      const dragEl = document.createElement('span')
      dragEl.className = 'pop-layer-drag'
      dragEl.draggable = true
      dragEl.setAttribute('aria-hidden', 'true')
      dragEl.textContent = '⠿'
      dragEl.addEventListener('dragstart', (e) => {
        layerDragId = id
        e.dataTransfer?.setData('text/plain', id)
        e.dataTransfer!.effectAllowed = 'move'
        li.classList.add('pop-layer-dragging')
      })
      dragEl.addEventListener('dragend', () => {
        layerDragId = null
        layerDropTargetId = null
        layerDropKind = null
        layerList.querySelectorAll('.pop-layer-drop-before, .pop-layer-drop-into').forEach((el) => {
          el.classList.remove('pop-layer-drop-before', 'pop-layer-drop-into')
        })
        li.classList.remove('pop-layer-dragging')
      })

      const input = document.createElement('input')
      input.type = 'text'
      input.className = 'pop-layer-name'
      input.spellcheck = false
      input.placeholder = itemLabel(item, definitions)
      input.value = layerNames[id] ?? ''
      input.setAttribute('aria-label', 'Layer name')
      input.addEventListener('pointerdown', (e) => e.stopPropagation())
      input.addEventListener('click', (e) => e.stopPropagation())
      input.addEventListener('focus', () => {
        selected = new Set([id])
        updateSelectionUi()
        syncPropsFromSelection()
        renderHandles()
      })
      input.addEventListener('input', () => {
        const raw = input.value
        if (raw.trim() === '') delete layerNames[id]
        else layerNames[id] = raw
        schedulePersist()
      })
      input.addEventListener('blur', () => {
        const v = input.value.trim()
        if (v === '') {
          delete layerNames[id]
          input.value = ''
        } else {
          layerNames[id] = v
          input.value = v
        }
        schedulePersist()
      })

      row.appendChild(dragEl)
      row.appendChild(input)
      li.appendChild(row)

      li.addEventListener('dragover', (e) => {
        if (!layerDragId || layerDragId === id) return
        e.preventDefault()
        e.dataTransfer!.dropEffect = 'move'
        const rect = li.getBoundingClientRect()
        const into = item.type === 'group' && e.clientY > rect.top + rect.height * 0.35
        layerList.querySelectorAll('.pop-layer-drop-before, .pop-layer-drop-into').forEach((el) => {
          el.classList.remove('pop-layer-drop-before', 'pop-layer-drop-into')
        })
        if (into) {
          li.classList.add('pop-layer-drop-into')
          layerDropKind = 'into'
        } else {
          li.classList.add('pop-layer-drop-before')
          layerDropKind = 'before'
        }
        layerDropTargetId = id
      })

      li.addEventListener('dragleave', () => {
        li.classList.remove('pop-layer-drop-before', 'pop-layer-drop-into')
      })

      li.addEventListener('drop', (e) => {
        e.preventDefault()
        const from = layerDragId ?? e.dataTransfer?.getData('text/plain')
        if (!from || !layerDropTargetId || !layerDropKind) return
        moveLayerNode(from, layerDropTargetId, layerDropKind)
        layerDragId = null
        layerDropTargetId = null
        layerDropKind = null
        commit()
      })

      li.addEventListener('dblclick', (e) => {
        if ((e.target as Element).closest('.pop-layer-name')) return
        if (item.type === 'instance') {
          enterComponentEdit(item.componentId)
        }
      })

      li.addEventListener('click', (e) => {
        if ((e.target as Element).closest('.pop-layer-name')) return
        if ((e.target as Element).closest('.pop-layer-drag')) return
        if (e.shiftKey) {
          if (selected.has(id)) selected.delete(id)
          else selected.add(id)
        } else {
          selected = new Set([id])
        }
        updateSelectionUi()
        syncPropsFromSelection()
        renderHandles()
      })

      host.appendChild(li)

      if (item.type === 'group') {
        const sub = document.createElement('ul')
        sub.className = 'pop-layer-nested'
        renderLayerBranch(sub, id, depth + 1)
        host.appendChild(sub)
      }
    }
  }

  function renderLayers(): void {
    const active = document.activeElement
    let preserveId: string | null = null
    let selStart = 0
    let selEnd = 0
    if (
      active instanceof HTMLInputElement &&
      active.classList.contains('pop-layer-name') &&
      layerList.contains(active)
    ) {
      preserveId = active.closest<HTMLLIElement>('.pop-layer')?.dataset.id ?? null
      selStart = active.selectionStart ?? 0
      selEnd = active.selectionEnd ?? 0
    }

    layerList.replaceChildren()
    renderLayerBranch(layerList, null, 0)

    layerList.addEventListener(
      'dragover',
      (e) => {
        if (!layerDragId) return
        e.preventDefault()
      },
      { passive: false },
    )

    if (preserveId) {
      const inp = layerList.querySelector<HTMLInputElement>(
        `li.pop-layer[data-id="${CSS.escape(preserveId)}"] .pop-layer-name`,
      )
      if (inp) {
        inp.focus()
        const len = inp.value.length
        const a = Math.min(selStart, len)
        const b = Math.min(selEnd, len)
        try {
          inp.setSelectionRange(a, b)
        } catch {
          /* ignore */
        }
      }
    }
    updateSelectionUi()
    updateCompPickList()
  }

  function renderItems(): void {
    itemsG.replaceChildren()
    for (const item of items) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.classList.add('pop-item')
      g.dataset.id = item.id
      if (item.type === 'rect') {
        const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        r.setAttribute('x', String(item.x))
        r.setAttribute('y', String(item.y))
        r.setAttribute('width', String(item.width))
        r.setAttribute('height', String(item.height))
        r.setAttribute('fill', item.fill)
        r.setAttribute('stroke', item.stroke)
        r.setAttribute('stroke-width', String(item.strokeWidth))
        g.appendChild(r)
      } else if (item.type === 'ellipse') {
        const el = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse')
        el.setAttribute('cx', String(item.x + item.width / 2))
        el.setAttribute('cy', String(item.y + item.height / 2))
        el.setAttribute('rx', String(item.width / 2))
        el.setAttribute('ry', String(item.height / 2))
        el.setAttribute('fill', item.fill)
        el.setAttribute('stroke', item.stroke)
        el.setAttribute('stroke-width', String(item.strokeWidth))
        g.appendChild(el)
      } else if (item.type === 'text') {
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        t.setAttribute('x', String(item.x))
        t.setAttribute('y', String(item.y + item.fontSize))
        t.setAttribute('font-size', String(item.fontSize))
        t.setAttribute('font-family', 'system-ui, sans-serif')
        t.setAttribute('fill', item.fill)
        t.textContent = item.content
        g.appendChild(t)
      } else {
        const im = document.createElementNS('http://www.w3.org/2000/svg', 'image')
        im.setAttribute('href', item.href)
        im.setAttribute('x', String(item.x))
        im.setAttribute('y', String(item.y))
        im.setAttribute('width', String(item.width))
        im.setAttribute('height', String(item.height))
        im.setAttribute('preserveAspectRatio', 'none')
        g.appendChild(im)
      }
      itemsG.appendChild(g)
    }
    updateSelectionUi()
  }

  const HANDLE_HALF = 5

  function renderHandles(): void {
    handlesG.replaceChildren()
    if (tool !== 'select' || selected.size !== 1) return
    const id = [...selected][0]!
    const it = getItemById(id)
    if (!it) return

    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    outline.setAttribute('x', String(it.x))
    outline.setAttribute('y', String(it.y))
    outline.setAttribute('width', String(it.width))
    outline.setAttribute('height', String(it.height))
    outline.setAttribute('fill', 'none')
    outline.setAttribute('stroke', '#a5b4fc')
    outline.setAttribute('stroke-width', '1')
    outline.setAttribute('stroke-dasharray', '5 4')
    outline.setAttribute('vector-effect', 'non-scaling-stroke')
    outline.setAttribute('pointer-events', 'none')
    handlesG.appendChild(outline)

    const addHandle = (hid: ResizeHandleId, px: number, py: number): void => {
      const hr = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      hr.setAttribute('x', String(px - HANDLE_HALF))
      hr.setAttribute('y', String(py - HANDLE_HALF))
      hr.setAttribute('width', String(HANDLE_HALF * 2))
      hr.setAttribute('height', String(HANDLE_HALF * 2))
      hr.setAttribute('fill', '#1a1e28')
      hr.setAttribute('stroke', '#7c9cff')
      hr.setAttribute('stroke-width', '1')
      hr.setAttribute('data-pop-handle', hid)
      hr.setAttribute('data-item-id', id)
      hr.setAttribute('vector-effect', 'non-scaling-stroke')
      hr.style.cursor = HANDLE_CURSORS[hid]
      handlesG.appendChild(hr)
    }

    const { x, y, width: w, height: h } = it
    addHandle('nw', x, y)
    addHandle('n', x + w / 2, y)
    addHandle('ne', x + w, y)
    addHandle('e', x + w, y + h / 2)
    addHandle('se', x + w, y + h)
    addHandle('s', x + w / 2, y + h)
    addHandle('sw', x, y + h)
    addHandle('w', x, y + h / 2)
  }

  function commit(): void {
    pruneLayerNames()
    renderItems()
    renderHandles()
    renderLayers()
    renderStaticGuides()
    if (!propsPanelFocused) syncPropsFromSelection()
    schedulePersist()
  }

  function clientToSvg(ev: PointerEvent): { x: number; y: number } {
    return clientToSvgCoords(ev.clientX, ev.clientY)
  }

  function hitItemId(ev: PointerEvent): string | null {
    const { x, y } = clientToSvg(ev)
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (x >= it.x && x <= it.x + it.width && y >= it.y && y <= it.y + it.height) {
        return it.id
      }
    }
    return null
  }

  toolButtons.forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool as Tool))
  })

  syncViewportTransform()
  updateZoomPctLabel()

  btnZoomIn.addEventListener('click', () => {
    zoomAtWorldPoint(VIEW_W / 2, VIEW_H / 2, viewScale * 1.2)
  })
  btnZoomOut.addEventListener('click', () => {
    zoomAtWorldPoint(VIEW_W / 2, VIEW_H / 2, viewScale / 1.2)
  })
  btnZoomReset.addEventListener('click', () => {
    viewTx = 0
    viewTy = 0
    viewScale = 1
    syncViewportTransform()
    updateZoomPctLabel()
    schedulePersist()
  })

  canvasWrap.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return
      if (!canvasWrap.contains(ev.target as Node)) return
      ev.preventDefault()
      const wf = clientToSvgCoords(ev.clientX, ev.clientY)
      const factor = Math.exp(-ev.deltaY * 0.002)
      zoomAtWorldPoint(wf.x, wf.y, viewScale * factor)
    },
    { passive: false },
  )

  fillInput.addEventListener('input', () => {
    syncChromeFromInputs()
    updateFillSwatch()
    for (const id of selected) {
      const it = getItemById(id)
      if (!it) continue
      if (it.type === 'rect' || it.type === 'ellipse' || it.type === 'text') {
        it.fill = defaultFill
      }
    }
    commit()
  })

  strokeInput.addEventListener('input', () => {
    syncChromeFromInputs()
    updateStrokeSwatch()
    for (const id of selected) {
      const it = getItemById(id)
      if (it && (it.type === 'rect' || it.type === 'ellipse')) {
        it.stroke = defaultStroke
      }
    }
    commit()
  })

  strokeWInput.addEventListener('input', () => {
    syncChromeFromInputs()
    for (const id of selected) {
      const it = getItemById(id)
      if (it && (it.type === 'rect' || it.type === 'ellipse')) {
        it.strokeWidth = defaultStrokeWidth
      }
    }
    commit()
  })

  btnDelete.addEventListener('click', () => {
    items = items.filter((i) => !selected.has(i.id))
    selected.clear()
    commit()
  })

  btnExportSel.addEventListener('click', () => {
    const list = items.filter((i) => selected.has(i.id))
    if (list.length === 0) {
      alert('Select one or more layers first (click on the canvas or list, Shift for multi-select).')
      return
    }
    downloadSvg(serializeSvg(list, VIEW_W, VIEW_H), 'pop-selection.svg')
  })

  btnExportAll.addEventListener('click', () => {
    downloadSvg(serializeSvg(items, VIEW_W, VIEW_H), 'pop-canvas.svg')
  })

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const href = String(reader.result)
      const img = new Image()
      img.onload = () => {
        const max = 280
        let w = img.naturalWidth
        let h = img.naturalHeight
        const scale = Math.min(1, max / w, max / h)
        w *= scale
        h *= scale
        const x = (VIEW_W - w) / 2
        const y = (VIEW_H - h) / 2
        const nid = newId()
        items.push({
          id: nid,
          type: 'image',
          x,
          y,
          width: w,
          height: h,
          href,
        })
        selected = new Set([nid])
        setTool('select')
        commit()
      }
      img.src = href
    }
    reader.readAsDataURL(file)
  })

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return

    const handleEl = (ev.target as Element).closest?.('[data-pop-handle]')
    if (handleEl && tool === 'select' && selected.size === 1) {
      const hid = handleEl.getAttribute('data-pop-handle') as ResizeHandleId | null
      const iid = handleEl.getAttribute('data-item-id')
      const only = [...selected][0]
      if (hid && iid && only === iid) {
        const it = getItemById(iid)
        if (it) {
          ev.preventDefault()
          resizeState.active = true
          resizeState.pointerId = ev.pointerId
          resizeState.handle = hid
          resizeState.itemId = iid
          resizeState.start = {
            x: it.x,
            y: it.y,
            width: it.width,
            height: it.height,
          }
          resizeState.startFontSize = it.type === 'text' ? it.fontSize : undefined
          svg.setPointerCapture(ev.pointerId)
        }
        return
      }
    }

    syncChromeFromInputs()
    const id = hitItemId(ev)

    if (tool === 'select') {
      if (id) {
        if (ev.shiftKey) {
          if (selected.has(id)) selected.delete(id)
          else selected.add(id)
        } else if (!selected.has(id)) {
          selected = new Set([id])
        }
        updateSelectionUi()
        syncPropsFromSelection()
        renderHandles()
        dragState.active = true
        dragState.pointerId = ev.pointerId
        const p0 = clientToSvg(ev)
        dragState.startSvgX = p0.x
        dragState.startSvgY = p0.y
        dragState.origins.clear()
        for (const sid of selected) {
          const it = getItemById(sid)
          if (it) dragState.origins.set(sid, { x: it.x, y: it.y })
        }
        svg.setPointerCapture(ev.pointerId)
      } else {
        if (!ev.shiftKey) selected.clear()
        updateSelectionUi()
        syncPropsFromSelection()
        renderHandles()
      }
      return
    }

    if (id) return

    const { x, y } = clientToSvg(ev)

    if (tool === 'rect') {
      const w = 140
      const h = 90
      const nid = newId()
      items.push({
        id: nid,
        type: 'rect',
        x: x - w / 2,
        y: y - h / 2,
        width: w,
        height: h,
        fill: defaultFill,
        stroke: defaultStroke,
        strokeWidth: defaultStrokeWidth,
      })
      selected = new Set([nid])
      setTool('select')
    } else if (tool === 'ellipse') {
      const w = 120
      const h = 120
      const nid = newId()
      items.push({
        id: nid,
        type: 'ellipse',
        x: x - w / 2,
        y: y - h / 2,
        width: w,
        height: h,
        fill: defaultFill,
        stroke: defaultStroke,
        strokeWidth: defaultStrokeWidth,
      })
      selected = new Set([nid])
      setTool('select')
    } else if (tool === 'text') {
      const content = window.prompt('Text to place', 'Hello')
      if (content === null) return
      const fontSize = 28
      const nid = newId()
      items.push({
        id: nid,
        type: 'text',
        x,
        y: y - fontSize,
        width: 200,
        height: fontSize,
        content,
        fontSize,
        fill: defaultFill,
      })
      selected = new Set([nid])
      setTool('select')
    }

    commit()
  })

  window.addEventListener('pointermove', (ev) => {
    if (resizeState.active && ev.pointerId === resizeState.pointerId) {
      const it = resizeState.itemId ? getItemById(resizeState.itemId) : undefined
      const hid = resizeState.handle
      if (!it || !hid) return
      const p = clientToSvg(ev)
      const out = applyResizeHandle(hid, p.x, p.y, resizeState.start)
      it.x = out.x
      it.y = out.y
      it.width = out.width
      it.height = out.height
      if (it.type === 'text' && resizeState.startFontSize !== undefined) {
        const sw = resizeState.start.width
        const sh = resizeState.start.height
        const ratio = Math.min(out.width / sw, out.height / sh)
        it.fontSize = clamp(Math.round(resizeState.startFontSize * ratio), 4, 400)
      }
      renderItems()
      renderHandles()
      if (!propsPanelFocused) syncPropsFromSelection()
      return
    }

    if (!dragState.active || ev.pointerId !== dragState.pointerId) return
    const p = clientToSvg(ev)
    const dx = p.x - dragState.startSvgX
    const dy = p.y - dragState.startSvgY
    for (const sid of selected) {
      const origin = dragState.origins.get(sid)
      const it = getItemById(sid)
      if (!origin || !it) continue
      it.x = origin.x + dx
      it.y = origin.y + dy
    }

    let vGuide: number | null = null
    let hGuide: number | null = null
    lastSnapHint = null

    if (symmetryGuidesOn && selected.size > 0) {
      const u = unionBounds(selected, getItemById)
      if (u) {
        const tx = collectSnapTargetsX(selected, items)
        const ty = collectSnapTargetsY(selected, items)
        const sx = snapAxis('x', u.left, u.cx, u.right, tx, SNAP_PX)
        const sy = snapAxis('y', u.top, u.cy, u.bottom, ty, SNAP_PX)
        if (sx.delta !== 0 || sy.delta !== 0) {
          for (const sid of selected) {
            const it = getItemById(sid)
            if (it) {
              it.x += sx.delta
              it.y += sy.delta
            }
          }
        }
        if (sx.delta !== 0 && sx.guide !== null) vGuide = sx.guide
        if (sy.delta !== 0 && sy.guide !== null) hGuide = sy.guide
        const parts = [sx.label, sy.label].filter(Boolean)
        if (parts.length) lastSnapHint = parts.join(' · ')
      }
    }

    renderItems()
    renderHandles()
    renderSnapGuides(vGuide, hGuide)
    if (symmetryGuidesOn && lastSnapHint) symHint.textContent = lastSnapHint
    else if (symmetryGuidesOn) setBaseSymHint()
  })

  window.addEventListener('pointerup', (ev) => {
    if (resizeState.active && ev.pointerId === resizeState.pointerId) {
      resizeState.active = false
      resizeState.pointerId = null
      resizeState.handle = null
      resizeState.itemId = null
      try {
        svg.releasePointerCapture(ev.pointerId)
      } catch {
        /* ignore */
      }
      renderHandles()
      renderLayers()
      if (!propsPanelFocused) syncPropsFromSelection()
      schedulePersist()
      return
    }

    if (!dragState.active || ev.pointerId !== dragState.pointerId) return
    dragState.active = false
    dragState.pointerId = null
    dragState.origins.clear()
    try {
      svg.releasePointerCapture(ev.pointerId)
    } catch {
      /* ignore */
    }
    renderSnapGuides(null, null)
    if (lastSnapHint) flashSnapHint(lastSnapHint)
    else setBaseSymHint()
    lastSnapHint = null
    renderLayers()
    renderHandles()
    if (!propsPanelFocused) syncPropsFromSelection()
    schedulePersist()
  })

  window.addEventListener('pointercancel', (ev) => {
    if (resizeState.active && ev.pointerId === resizeState.pointerId) {
      resizeState.active = false
      resizeState.pointerId = null
      resizeState.handle = null
      resizeState.itemId = null
      renderHandles()
      renderLayers()
      if (!propsPanelFocused) syncPropsFromSelection()
      schedulePersist()
      return
    }
    if (ev.pointerId === dragState.pointerId) {
      dragState.active = false
      dragState.pointerId = null
      dragState.origins.clear()
      renderSnapGuides(null, null)
      setBaseSymHint()
      lastSnapHint = null
      renderLayers()
      renderHandles()
      if (!propsPanelFocused) syncPropsFromSelection()
      schedulePersist()
    }
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      const t = ev.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (selected.size === 0) return
      ev.preventDefault()
      items = items.filter((i) => !selected.has(i.id))
      selected.clear()
      commit()
    }
  })

  setBaseSymHint()
  commit()
}
