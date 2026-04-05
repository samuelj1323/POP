import { clamp } from './math.ts'
import type {
  CanvasItem,
  ComponentDefinition,
  DefNode,
  GroupLayout,
  SceneGroup,
  SceneNode,
} from './scene-types.ts'

export const STORAGE_KEY_V3 = 'pop-studio-state-v3'
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

/** Accepts stored JSON (possibly missing `rx` / `opacity`) and returns a fully normalized scene node. */
export function normalizeSceneNode(x: unknown): SceneNode | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string' || typeof o.type !== 'string') return null
  const n = (k: string) => typeof o[k] === 'number'
  const s = (k: string) => typeof o[k] === 'string'
  const parentOk = o.parentId === null || typeof o.parentId === 'string'
  if (!parentOk) return null

  const readOpacity = (): number => {
    if (n('opacity') && Number.isFinite(o.opacity as number)) return clamp(o.opacity as number, 0, 1)
    return 1
  }

  switch (o.type) {
    case 'group':
      if (
        !(
          n('x') &&
          n('y') &&
          n('width') &&
          n('height') &&
          Array.isArray(o.childIds) &&
          (o.childIds as unknown[]).every((c) => typeof c === 'string')
        )
      ) {
        return null
      }
      {
        const base = { ...o } as Record<string, unknown>
        const layoutRaw = base.layout
        let layout: GroupLayout | undefined
        if (layoutRaw && typeof layoutRaw === 'object') {
          const L = layoutRaw as Record<string, unknown>
          if (L.type === 'none') layout = { type: 'none' }
          else if (
            L.type === 'stack' &&
            (L.direction === 'horizontal' || L.direction === 'vertical') &&
            typeof L.gap === 'number' &&
            typeof L.padding === 'number'
          ) {
            layout = {
              type: 'stack',
              direction: L.direction,
              gap: L.gap,
              padding: L.padding,
            }
          }
        }
        const exportRoleRaw = base.exportRole
        const exportRole =
          typeof exportRoleRaw === 'string' &&
          ['auto', 'div', 'button', 'section', 'main', 'header', 'footer', 'nav', 'card'].includes(
            exportRoleRaw,
          )
            ? (exportRoleRaw as SceneGroup['exportRole'])
            : undefined
        const g: SceneGroup = {
          ...(base as unknown as SceneGroup),
          ...(layout ? { layout } : {}),
          ...(exportRole ? { exportRole } : {}),
        }
        return g as unknown as SceneNode
      }
    case 'instance':
      if (!(n('x') && n('y') && n('width') && n('height') && s('componentId'))) return null
      return o as unknown as SceneNode
    case 'rect':
    case 'ellipse':
      if (
        !(
          n('x') &&
          n('y') &&
          n('width') &&
          n('height') &&
          s('fill') &&
          s('stroke') &&
          typeof o.strokeWidth === 'number'
        )
      ) {
        return null
      }
      if (o.type === 'rect') {
        const rxRaw = n('rx') && Number.isFinite(o.rx as number) ? (o.rx as number) : 0
        return {
          ...o,
          rx: Math.max(0, rxRaw),
          opacity: readOpacity(),
        } as unknown as SceneNode
      }
      return { ...o, opacity: readOpacity() } as unknown as SceneNode
    case 'text':
      if (!(n('x') && n('y') && n('width') && n('height') && s('content') && n('fontSize') && s('fill'))) {
        return null
      }
      {
        const fontFamily =
          s('fontFamily') && typeof o.fontFamily === 'string' ? o.fontFamily : 'system-ui, sans-serif'
        const fontWeight =
          n('fontWeight') && Number.isFinite(o.fontWeight as number)
            ? Math.round(clamp(o.fontWeight as number, 100, 900))
            : 400
        const letterSpacing =
          n('letterSpacing') && Number.isFinite(o.letterSpacing as number) ? (o.letterSpacing as number) : 0
        const lineHeight =
          n('lineHeight') && Number.isFinite(o.lineHeight as number) && (o.lineHeight as number) > 0
            ? (o.lineHeight as number)
            : 1.2
        return {
          ...o,
          opacity: readOpacity(),
          fontFamily,
          fontWeight,
          letterSpacing,
          lineHeight,
        } as unknown as SceneNode
      }
    case 'image':
      if (!(n('x') && n('y') && n('width') && n('height') && s('href'))) return null
      return { ...o, opacity: readOpacity() } as unknown as SceneNode
    default:
      return null
  }
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
        rx: 0,
        opacity: 1,
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
        opacity: 1,
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
        opacity: 1,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 400,
        letterSpacing: 0,
        lineHeight: 1.2,
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
        opacity: 1,
      })
    }
    return it.id
  })
  return { rootIds, nodes: nodeMap }
}

export function recordToNodes(r: Record<string, unknown>): Map<string, SceneNode> {
  const m = new Map<string, SceneNode>()
  for (const k of Object.keys(r)) {
    const n = normalizeSceneNode(r[k])
    if (n) m.set(k, n)
  }
  return m
}

export function nodesToRecord(nodes: Map<string, SceneNode>): Record<string, SceneNode> {
  const rec: Record<string, SceneNode> = {}
  for (const [k, v] of nodes) rec[k] = v
  return rec
}

export function recordToDefs(r: Record<string, unknown>): Map<string, ComponentDefinition> {
  const m = new Map<string, ComponentDefinition>()
  for (const k of Object.keys(r)) {
    const entry = r[k]
    if (!entry || typeof entry !== 'object') continue
    const def = entry as ComponentDefinition
    if (
      typeof def.id !== 'string' ||
      typeof def.name !== 'string' ||
      typeof def.rootId !== 'string' ||
      typeof def.intrinsicW !== 'number' ||
      typeof def.intrinsicH !== 'number' ||
      !def.nodes ||
      typeof def.nodes !== 'object'
    ) {
      continue
    }
    const rawNodes = def.nodes as Record<string, unknown>
    const newNodes: Record<string, DefNode> = {}
    let ok = true
    for (const nk of Object.keys(rawNodes)) {
      const nn = normalizeSceneNode(rawNodes[nk])
      if (!nn || nn.type === 'instance') {
        ok = false
        break
      }
      newNodes[nk] = nn as DefNode
    }
    if (!ok || !newNodes[def.rootId]) continue
    m.set(k, { ...def, nodes: newNodes })
  }
  return m
}

export function defsToRecord(defs: Map<string, ComponentDefinition>): Record<string, ComponentDefinition> {
  const rec: Record<string, ComponentDefinition> = {}
  for (const [k, v] of defs) rec[k] = v
  return rec
}
