export type Tool = 'select' | 'rect' | 'ellipse' | 'text' | 'image'

export type SceneNodeBase = { id: string; parentId: string | null }

export type GroupLayout =
  | { type: 'none' }
  | {
      type: 'stack'
      direction: 'horizontal' | 'vertical'
      gap: number
      padding: number
    }

export type HtmlExportRole =
  | 'auto'
  | 'div'
  | 'button'
  | 'section'
  | 'main'
  | 'header'
  | 'footer'
  | 'nav'
  | 'card'

export type SceneLeaf =
  | (SceneNodeBase & {
      type: 'rect'
      x: number
      y: number
      width: number
      height: number
      fill: string
      /** When set, fill resolves from `DesignTokens.colors[fillToken]` with fallback to `fill`. */
      fillToken?: string
      stroke: string
      strokeToken?: string
      strokeWidth: number
      rx: number
      opacity: number
    })
  | (SceneNodeBase & {
      type: 'ellipse'
      x: number
      y: number
      width: number
      height: number
      fill: string
      fillToken?: string
      stroke: string
      strokeToken?: string
      strokeWidth: number
      opacity: number
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
      fillToken?: string
      opacity: number
      /** CSS font-family stack */
      fontFamily: string
      fontWeight: number
      /** px */
      letterSpacing: number
      /** Unitless line height (e.g. 1.2) */
      lineHeight: number
    })
  | (SceneNodeBase & {
      type: 'image'
      x: number
      y: number
      width: number
      height: number
      href: string
      opacity: number
    })

export type SceneGroup = SceneNodeBase & {
  type: 'group'
  x: number
  y: number
  width: number
  height: number
  childIds: string[]
  layout?: GroupLayout
  exportRole?: HtmlExportRole
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
