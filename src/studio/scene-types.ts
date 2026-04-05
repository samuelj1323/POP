export type Tool = 'select' | 'rect' | 'ellipse' | 'text' | 'image'

export type SceneNodeBase = { id: string; parentId: string | null }

export type SceneLeaf =
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

export type SceneGroup = SceneNodeBase & {
  type: 'group'
  x: number
  y: number
  width: number
  height: number
  childIds: string[]
}

export type SceneInstance = SceneNodeBase & {
  type: 'instance'
  componentId: string
  x: number
  y: number
  width: number
  height: number
}

export type SceneNode = SceneLeaf | SceneGroup | SceneInstance

export type DefNode = Exclude<SceneNode, { type: 'instance' }>

export type ComponentDefinition = {
  id: string
  name: string
  rootId: string
  intrinsicW: number
  intrinsicH: number
  nodes: Record<string, DefNode>
}

/** Legacy flat canvas item (persist v1 only). */
export type CanvasItem =
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
