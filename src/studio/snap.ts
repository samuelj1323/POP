import { VIEW_H, VIEW_W } from './constants.ts'
import { worldFrame } from './layout-geometry.ts'
import type { ComponentDefinition, SceneNode } from './scene-types.ts'

export function collectSnapTargetsX(
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

export function collectSnapTargetsY(
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
export function snapAxis(
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
