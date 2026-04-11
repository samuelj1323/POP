import { VIEW_H, VIEW_W } from './constants.ts'
import { newId } from './id.ts'
import { collectSubtreeIds, unionBoundsWorld } from './layout-geometry.ts'
import type { ComponentDefinition, SceneNode } from './scene-types.ts'
import type { PersistedStateV2 } from './persistence.ts'
import { recordToDefs, recordToNodes } from './persistence.ts'

/** User-uploaded HTML/CSS snippets merged into HTML export and live preview (`srcdoc`). */
export type UploadedLibraryAsset = {
  id: string
  name: string
  kind: 'css' | 'html'
  content: string
}

export type PopDocumentMeta = {
  name: string
  updatedAt?: string
  /** Absolute URLs for `<link rel="stylesheet">` in exported HTML (design system CSS, fonts). */
  htmlExportStylesheets?: string[]
  /** Injected into exported HTML / preview: CSS as `<style>`, HTML appended after the frame. */
  uploadedLibraryAssets?: UploadedLibraryAsset[]
}

export type DesignTokens = {
  colors?: Record<string, string>
  radii?: Record<string, number>
  space?: Record<string, number>
}

/** One screen / artboard; rootIds are top-level layers inside this frame. */
export type PopFrame = {
  id: string
  label: string
  x: number
  y: number
  width: number
  height: number
  rootIds: string[]
}

export type PopDocumentV3 = {
  v: 3
  meta: PopDocumentMeta
  tokens: DesignTokens
  frames: PopFrame[]
  activeFrameId: string
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

export function createDefaultFrame(): PopFrame {
  return {
    id: newId(),
    label: 'Frame 1',
    x: 0,
    y: 0,
    width: VIEW_W,
    height: VIEW_H,
    rootIds: [],
  }
}

export function computeWorldBounds(
  frames: PopFrame[],
  minW = VIEW_W,
  minH = VIEW_H,
): { worldW: number; worldH: number } {
  if (frames.length === 0) return { worldW: minW, worldH: minH }
  let maxX = minW
  let maxY = minH
  for (const f of frames) {
    maxX = Math.max(maxX, f.x + f.width)
    maxY = Math.max(maxY, f.y + f.height)
  }
  return { worldW: maxX, worldH: maxY }
}

/** World size for the canvas: union of frame rectangles and all layer bounds (content can extend past frames). */
export function computeWorldBoundsWithContent(
  frames: PopFrame[],
  nodes: Map<string, SceneNode>,
  definitions: Map<string, ComponentDefinition>,
  minW = VIEW_W,
  minH = VIEW_H,
): { worldW: number; worldH: number } {
  if (frames.length === 0) return { worldW: minW, worldH: minH }
  let maxX = minW
  let maxY = minH
  for (const f of frames) {
    maxX = Math.max(maxX, f.x + f.width)
    maxY = Math.max(maxY, f.y + f.height)
    for (const rid of f.rootIds) {
      const ids = collectSubtreeIds(nodes, rid)
      const u = unionBoundsWorld(ids, nodes, definitions)
      if (u) {
        maxX = Math.max(maxX, u.right)
        maxY = Math.max(maxY, u.bottom)
      }
    }
  }
  return { worldW: maxX, worldH: maxY }
}

export function migrateV2ToV3(v2: PersistedStateV2): PopDocumentV3 {
  const frame = createDefaultFrame()
  frame.rootIds = [...v2.rootIds]
  frame.width = VIEW_W
  frame.height = VIEW_H
  frame.x = 0
  frame.y = 0
  frame.label = 'Frame 1'
  return {
    v: 3,
    meta: {
      name: 'Untitled',
      updatedAt: new Date().toISOString(),
    },
    tokens: {},
    frames: [frame],
    activeFrameId: frame.id,
    nodes: v2.nodes,
    layerNames: { ...v2.layerNames },
    definitions: v2.definitions,
    defaultFill: v2.defaultFill,
    defaultStroke: v2.defaultStroke,
    defaultStrokeWidth: v2.defaultStrokeWidth,
    symmetryGuidesOn: v2.symmetryGuidesOn,
    viewTx: v2.viewTx,
    viewTy: v2.viewTy,
    viewScale: v2.viewScale,
  }
}

export function documentToV3Json(doc: PopDocumentV3): string {
  return JSON.stringify(doc, null, 2)
}

export function parseDocumentJson(raw: string): unknown {
  return JSON.parse(raw) as unknown
}

/** Validate and normalize a v3 document from external JSON. Returns null if invalid. */
export function loadDocumentV3(data: unknown): PopDocumentV3 | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  if (o.v !== 3) return null
  if (!o.meta || typeof o.meta !== 'object') return null
  const meta = o.meta as Record<string, unknown>
  if (typeof meta.name !== 'string') return null

  if (!Array.isArray(o.frames) || o.frames.length === 0) return null
  const frames: PopFrame[] = []
  for (const fr of o.frames) {
    if (!fr || typeof fr !== 'object') return null
    const f = fr as Record<string, unknown>
    if (typeof f.id !== 'string' || typeof f.label !== 'string') return null
    if (
      typeof f.x !== 'number' ||
      typeof f.y !== 'number' ||
      typeof f.width !== 'number' ||
      typeof f.height !== 'number'
    ) {
      return null
    }
    if (f.width < 1 || f.height < 1) return null
    if (!Array.isArray(f.rootIds) || !f.rootIds.every((id) => typeof id === 'string')) return null
    frames.push({
      id: f.id,
      label: f.label,
      x: f.x,
      y: f.y,
      width: f.width,
      height: f.height,
      rootIds: [...f.rootIds],
    })
  }

  let activeFrameId = typeof o.activeFrameId === 'string' ? o.activeFrameId : frames[0]!.id
  if (!frames.some((f) => f.id === activeFrameId)) activeFrameId = frames[0]!.id

  if (!o.nodes || typeof o.nodes !== 'object') return null
  const nodes = recordToNodes(o.nodes as Record<string, unknown>)
  if (nodes.size === 0 && frames.some((f) => f.rootIds.length > 0)) {
    /* allow empty scene */
  }

  const definitions = o.definitions && typeof o.definitions === 'object' ? recordToDefs(o.definitions as Record<string, unknown>) : new Map()

  const layerNames =
    o.layerNames && typeof o.layerNames === 'object' ? { ...(o.layerNames as Record<string, string>) } : {}

  const tokens: DesignTokens =
    o.tokens && typeof o.tokens === 'object' ? (o.tokens as DesignTokens) : {}

  const htmlExportStylesheets =
    Array.isArray(meta.htmlExportStylesheets) &&
    (meta.htmlExportStylesheets as unknown[]).every((x) => typeof x === 'string')
      ? [...(meta.htmlExportStylesheets as string[])]
      : undefined

  let uploadedLibraryAssets: UploadedLibraryAsset[] | undefined
  if (Array.isArray(meta.uploadedLibraryAssets)) {
    const out: UploadedLibraryAsset[] = []
    for (const raw of meta.uploadedLibraryAssets as unknown[]) {
      if (!raw || typeof raw !== 'object') continue
      const a = raw as Record<string, unknown>
      if (typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.content !== 'string') continue
      if (a.kind !== 'css' && a.kind !== 'html') continue
      out.push({ id: a.id, name: a.name, kind: a.kind, content: a.content })
    }
    if (out.length > 0) uploadedLibraryAssets = out
  }

  const doc: PopDocumentV3 = {
    v: 3,
    meta: {
      name: meta.name,
      updatedAt: typeof meta.updatedAt === 'string' ? meta.updatedAt : undefined,
      ...(htmlExportStylesheets !== undefined ? { htmlExportStylesheets } : {}),
      ...(uploadedLibraryAssets !== undefined ? { uploadedLibraryAssets } : {}),
    },
    tokens,
    frames,
    activeFrameId,
    nodes: Object.fromEntries(nodes) as Record<string, SceneNode>,
    layerNames,
    definitions: Object.fromEntries(definitions) as Record<string, ComponentDefinition>,
    defaultFill: typeof o.defaultFill === 'string' ? o.defaultFill : '#a78bfa',
    defaultStroke: typeof o.defaultStroke === 'string' ? o.defaultStroke : '#4c1d95',
    defaultStrokeWidth:
      typeof o.defaultStrokeWidth === 'number' && Number.isFinite(o.defaultStrokeWidth)
        ? o.defaultStrokeWidth
        : 2,
    symmetryGuidesOn: typeof o.symmetryGuidesOn === 'boolean' ? o.symmetryGuidesOn : true,
    viewTx: typeof o.viewTx === 'number' ? o.viewTx : undefined,
    viewTy: typeof o.viewTy === 'number' ? o.viewTy : undefined,
    viewScale: typeof o.viewScale === 'number' ? o.viewScale : undefined,
  }

  return pruneOrphanFrameRoots(doc)
}

/** Remove root ids missing from the node map; dedupe frame overlap is caller responsibility. */
function pruneOrphanFrameRoots(doc: PopDocumentV3): PopDocumentV3 {
  const ids = new Set(Object.keys(doc.nodes))
  for (const f of doc.frames) {
    f.rootIds = f.rootIds.filter((id) => ids.has(id))
  }
  return doc
}
