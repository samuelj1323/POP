import type { CanvasItem, ComponentDefinition, DefNode, SceneNode } from './scene-types.ts'

export const STORAGE_KEY_V2 = 'pop-studio-state-v2'
export const STORAGE_KEY_V1 = 'pop-studio-state-v1'

export type PersistedStateV1 = {
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

export type PersistedStateV2 = {
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
}

export function isValidCanvasItem(x: unknown): x is CanvasItem {
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

export function migrateV1ToScene(items: CanvasItem[]): { rootIds: string[]; nodes: Map<string, SceneNode> } {
  const nodeMap = new Map<string, SceneNode>()
  const rootIds = items.map((it) => {
    const base = { id: it.id, parentId: null as string | null }
    if (it.type === 'rect') {
      nodeMap.set(it.id, {
        ...base,
        type: 'rect',
        x: it.x,
        y: it.y,
        width: it.width,
        height: it.height,
        fill: it.fill,
        stroke: it.stroke,
        strokeWidth: it.strokeWidth,
      })
    } else if (it.type === 'ellipse') {
      nodeMap.set(it.id, {
        ...base,
        type: 'ellipse',
        x: it.x,
        y: it.y,
        width: it.width,
        height: it.height,
        fill: it.fill,
        stroke: it.stroke,
        strokeWidth: it.strokeWidth,
      })
    } else if (it.type === 'text') {
      nodeMap.set(it.id, {
        ...base,
        type: 'text',
        x: it.x,
        y: it.y,
        width: it.width,
        height: it.height,
        content: it.content,
        fontSize: it.fontSize,
        fill: it.fill,
      })
    } else {
      nodeMap.set(it.id, {
        ...base,
        type: 'image',
        x: it.x,
        y: it.y,
        width: it.width,
        height: it.height,
        href: it.href,
      })
    }
    return it.id
  })
  return { rootIds, nodes: nodeMap }
}

export function recordToNodes(r: Record<string, SceneNode>): Map<string, SceneNode> {
  const m = new Map<string, SceneNode>()
  for (const k of Object.keys(r)) {
    const n = r[k]
    if (n && isValidSceneNode(n)) m.set(k, n)
  }
  return m
}

export function nodesToRecord(nodes: Map<string, SceneNode>): Record<string, SceneNode> {
  const rec: Record<string, SceneNode> = {}
  for (const [k, v] of nodes) rec[k] = v
  return rec
}

export function recordToDefs(r: Record<string, ComponentDefinition>): Map<string, ComponentDefinition> {
  const m = new Map<string, ComponentDefinition>()
  for (const k of Object.keys(r)) {
    const d = r[k]
    if (d && isValidComponentDefinition(d)) m.set(k, d)
  }
  return m
}

export function defsToRecord(defs: Map<string, ComponentDefinition>): Record<string, ComponentDefinition> {
  const rec: Record<string, ComponentDefinition> = {}
  for (const [k, v] of defs) rec[k] = v
  return rec
}
