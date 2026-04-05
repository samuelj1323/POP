import { worldFrame } from './layout-geometry.ts'
import type { ComponentDefinition, SceneNode } from './scene-types.ts'

/** World-rectangle used for canvas edge / center symmetry targets (typically the active frame). */
export type SnapBounds = {
  x: number
  y: number
  width: number
  height: number
}

export function collectSnapTargetsX(
  exclude: Set<string>,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  bounds: SnapBounds,
): number[] {
  const t = new Set<number>()
  const { x: bx, y: _by, width: bw, height: _bh } = bounds
  t.add(bx)
  t.add(bx + bw / 2)
  t.add(bx + bw)
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

export function collectSnapTargetsY(
  exclude: Set<string>,
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  bounds: SnapBounds,
): number[] {
  const t = new Set<number>()
  const { x: _bx, y: by, width: _bw, height: bh } = bounds
  t.add(by)
  t.add(by + bh / 2)
  t.add(by + bh)
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
export function snapAxis(
  axis: 'x' | 'y',
  a0: number,
  aMid: number,
  a1: number,
  targets: number[],
  maxDist: number,
  bounds: SnapBounds,
): { delta: number; guide: number | null; label: string | null } {
  const centerLine = axis === 'x' ? bounds.x + bounds.width / 2 : bounds.y + bounds.height / 2
  const spanMin = axis === 'x' ? bounds.x : bounds.y
  const spanMax = axis === 'x' ? bounds.x + bounds.width : bounds.y + bounds.height
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
        const onCanvasEdge = tx === spanMin || tx === spanMax
        let label: string | null = null
        if (onCanvasMid) {
          label = kind === 'center' ? 'Symmetric: aligned to frame center' : 'Symmetric: edge to center line'
        } else if (onCanvasEdge) {
          label = 'Aligned to frame edge'
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
