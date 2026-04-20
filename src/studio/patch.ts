import { newId } from './id.ts'
import type { DesignTokens, PopDocumentV3, PopFrame } from './document.ts'
import type { SceneNode } from './scene-types.ts'
import { normalizeSceneNode } from './persistence.ts'

export type PatchOp =
  | { op: 'setMeta'; name?: string; updatedAt?: string }
  | { op: 'setTokens'; tokens: Partial<DesignTokens> }
  | { op: 'setToken'; key: string; value: string | number; namespace: 'colors' | 'radii' | 'space' }
  | { op: 'addFrame'; frame: Omit<PopFrame, 'id' | 'rootIds'> & { id?: string; rootIds?: string[] } }
  | { op: 'updateFrame'; id: string; patch: Partial<Pick<PopFrame, 'label' | 'x' | 'y' | 'width' | 'height'>> }
  | { op: 'removeFrame'; id: string }
  | { op: 'setActiveFrame'; id: string }
  | { op: 'addNode'; node: SceneNode }
  | { op: 'updateNode'; id: string; patch: Record<string, unknown> }
  | { op: 'removeNode'; id: string }
  | { op: 'setFrameRoots'; frameId: string; rootIds: string[] }

export type PatchResult =
  | { ok: true; doc: PopDocumentV3 }
  | { ok: false; error: string }

function cloneDoc(doc: PopDocumentV3): PopDocumentV3 {
  return JSON.parse(JSON.stringify(doc)) as PopDocumentV3
}

export function applyPatch(doc: PopDocumentV3, ops: PatchOp[]): PatchResult {
  let d = cloneDoc(doc)
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!
    const r = applyOne(d, op)
    if (!r.ok) return { ok: false, error: `op ${i}: ${r.error}` }
    d = r.doc
  }
  d.meta.updatedAt = new Date().toISOString()
  return { ok: true, doc: d }
}

function applyOne(doc: PopDocumentV3, op: PatchOp): PatchResult {
  switch (op.op) {
    case 'setMeta': {
      if (op.name !== undefined) doc.meta.name = op.name
      if (op.updatedAt !== undefined) doc.meta.updatedAt = op.updatedAt
      return { ok: true, doc }
    }
    case 'setTokens': {
      doc.tokens = { ...doc.tokens, ...op.tokens }
      return { ok: true, doc }
    }
    case 'setToken': {
      const ns = op.namespace
      if (!doc.tokens[ns]) doc.tokens[ns] = {}
      const bucket = doc.tokens[ns] as Record<string, string | number>
      bucket[op.key] = op.value
      return { ok: true, doc }
    }
    case 'addFrame': {
      const id = op.frame.id ?? newId()
      const frame: PopFrame = {
        id,
        label: op.frame.label,
        x: op.frame.x,
        y: op.frame.y,
        width: op.frame.width,
        height: op.frame.height,
        rootIds: op.frame.rootIds ? [...op.frame.rootIds] : [],
      }
      if (frame.width < 1 || frame.height < 1) return { ok: false, error: 'frame dimensions invalid' }
      doc.frames.push(frame)
      return { ok: true, doc }
    }
    case 'updateFrame': {
      const f = doc.frames.find((x) => x.id === op.id)
      if (!f) return { ok: false, error: 'frame not found' }
      if (op.patch.label !== undefined) f.label = op.patch.label
      if (op.patch.x !== undefined) f.x = op.patch.x
      if (op.patch.y !== undefined) f.y = op.patch.y
      if (op.patch.width !== undefined) f.width = Math.max(1, op.patch.width)
      if (op.patch.height !== undefined) f.height = Math.max(1, op.patch.height)
      return { ok: true, doc }
    }
    case 'removeFrame': {
      if (doc.frames.length <= 1) return { ok: false, error: 'cannot remove last frame' }
      const idx = doc.frames.findIndex((x) => x.id === op.id)
      if (idx < 0) return { ok: false, error: 'frame not found' }
      doc.frames.splice(idx, 1)
      if (doc.activeFrameId === op.id) doc.activeFrameId = doc.frames[0]!.id
      return { ok: true, doc }
    }
    case 'setActiveFrame': {
      if (!doc.frames.some((x) => x.id === op.id)) return { ok: false, error: 'frame not found' }
      doc.activeFrameId = op.id
      return { ok: true, doc }
    }
    case 'addNode': {
      const n = normalizeSceneNode(op.node as unknown)
      if (!n) return { ok: false, error: 'invalid node' }
      if (doc.nodes[n.id]) return { ok: false, error: 'node id exists' }
      doc.nodes[n.id] = n
      return { ok: true, doc }
    }
    case 'updateNode': {
      const cur = doc.nodes[op.id]
      if (!cur) return { ok: false, error: 'node not found' }
      const merged = { ...cur, ...op.patch, id: op.id } as unknown
      const n = normalizeSceneNode(merged)
      if (!n) return { ok: false, error: 'invalid node after patch' }
      doc.nodes[op.id] = n
      return { ok: true, doc }
    }
    case 'removeNode': {
      if (!doc.nodes[op.id]) return { ok: false, error: 'node not found' }
      delete doc.nodes[op.id]
      for (const f of doc.frames) {
        f.rootIds = f.rootIds.filter((x) => x !== op.id)
      }
      return { ok: true, doc }
    }
    case 'setFrameRoots': {
      const f = doc.frames.find((x) => x.id === op.frameId)
      if (!f) return { ok: false, error: 'frame not found' }
      for (const rid of op.rootIds) {
        if (!doc.nodes[rid]) return { ok: false, error: `root ${rid} missing in nodes` }
      }
      f.rootIds = [...op.rootIds]
      return { ok: true, doc }
    }
    default: {
      const _exhaustive: never = op
      return { ok: false, error: `unknown op ${_exhaustive}` }
    }
  }
}
