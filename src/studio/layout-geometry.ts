import { MIN_ITEM_SIZE } from './constants.ts'
import type { ComponentDefinition, SceneNode } from './scene-types.ts'

export type ResizeHandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export function bboxFromOpposingCorners(
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

export function applyResizeHandle(
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

export const HANDLE_CURSORS: Record<ResizeHandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
}

export function worldFrame(
  nodes: Map<string, SceneNode>,
  _definitions: Map<string, ComponentDefinition>,
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

export function collectSubtreeIds(nodes: Map<string, SceneNode>, rootId: string): Set<string> {
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

export function isDescendant(nodes: Map<string, SceneNode>, ancestorId: string, nodeId: string): boolean {
  let cur: string | null = nodeId
  while (cur) {
    if (cur === ancestorId) return true
    cur = nodes.get(cur)?.parentId ?? null
  }
  return false
}

export function unionBoundsWorld(
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
