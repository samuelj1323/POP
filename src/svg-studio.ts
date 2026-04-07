import { buildExcelThemeGrid, EXCEL_STANDARD_COLORS, normalizeHex6 } from './studio/color-palette.ts'
import {
  MAX_VIEW_SCALE,
  MIN_ITEM_SIZE,
  MIN_VIEW_SCALE,
  GRID_PATTERN_WORLD,
  SNAP_PX,
  VIEW_H,
  VIEW_W,
} from './studio/constants.ts'
import { newId } from './studio/id.ts'
import {
  applyResizeHandle,
  collectSubtreeIds,
  HANDLE_CURSORS,
  isDescendant,
  unionBoundsWorld,
  worldFrame,
} from './studio/layout-geometry.ts'
import type { ResizeHandleId } from './studio/layout-geometry.ts'
import { clamp } from './studio/math.ts'
import {
  computeWorldBoundsWithContent,
  createDefaultFrame,
  documentToV3Json,
  loadDocumentV3,
  migrateV2ToV3,
  type DesignTokens,
  type PopDocumentV3,
  type PopFrame,
} from './studio/document.ts'
import {
  defsToRecord,
  isValidCanvasItem,
  migrateV1ToScene,
  nodesToRecord,
  recordToDefs,
  recordToNodes,
  STORAGE_KEY_V1,
  STORAGE_KEY_V2,
  STORAGE_KEY_V3,
} from './studio/persistence.ts'
import type { PersistedStateV1, PersistedStateV2 } from './studio/persistence.ts'
import type {
  ComponentDefinition,
  DefNode,
  GroupLayout,
  SceneGroup,
  SceneLeaf,
  SceneNode,
  Tool,
} from './studio/scene-types.ts'
import type { SnapBounds } from './studio/snap.ts'
import { collectSnapTargetsX, collectSnapTargetsY, snapAxis } from './studio/snap.ts'
import {
  buildSvgFragmentLeafLocal,
  downloadSvg,
  itemLabel,
  serializeDefSubtreeSvg,
  serializeSceneSubtreeSvg,
  serializeSvgFromRoots,
} from './studio/svg-export.ts'
import { downloadHtml, exportFrameToHtml } from './studio/html-export.ts'

/** POP editor UI (imperative DOM). Domain model: `src/studio/`. Repo context: `AGENTS.md`. */

const POP_CLIPBOARD_VERSION = 1 as const
const PASTE_OFFSET_WORLD = 10

type PopClipboardPayload = {
  popClipboard: typeof POP_CLIPBOARD_VERSION
  roots: string[]
  nodes: Record<string, SceneNode>
  layerNames?: Record<string, string>
}

function parsePopClipboard(raw: string): PopClipboardPayload | null {
  try {
    const o = JSON.parse(raw) as unknown
    if (!o || typeof o !== 'object') return null
    const p = o as Record<string, unknown>
    if (p.popClipboard !== POP_CLIPBOARD_VERSION) return null
    if (!Array.isArray(p.roots) || !p.roots.every((x): x is string => typeof x === 'string')) return null
    if (!p.nodes || typeof p.nodes !== 'object') return null
    return p as PopClipboardPayload
  } catch {
    return null
  }
}

/** Attach the full editor UI and behavior to `root`. */
export function mount(root: HTMLElement): void {
  let frames: PopFrame[] = [createDefaultFrame()]
  let activeFrameId = frames[0]!.id
  let docName = 'Untitled'
  let tokens: DesignTokens = {}
  /** When editing a component, scene roots are not frame roots. */
  let componentEditRoots: string[] | null = null
  let nodes = new Map<string, SceneNode>()
  let definitions = new Map<string, ComponentDefinition>()
  /** When set, canvas shows definition tree for editing the main component. */
  let editingComponentId: string | null = null
  let mainNodesBackup: Map<string, SceneNode> | null = null
  let mainRootIdsBackup: string[] | null = null
  let worldW = VIEW_W
  let worldH = VIEW_H

  function getActiveFrame(): PopFrame {
    const f = frames.find((x) => x.id === activeFrameId)
    if (f) return f
    return frames[0]!
  }

  function roots(): string[] {
    if (componentEditRoots !== null) return componentEditRoots
    return getActiveFrame().rootIds
  }

  function snapBoundsForFrame(): SnapBounds {
    const f = getActiveFrame()
    return { x: f.x, y: f.y, width: f.width, height: f.height }
  }

  function recomputeWorldSize(): void {
    const b = computeWorldBoundsWithContent(frames, nodes, definitions, VIEW_W, VIEW_H)
    let maxX = b.worldW
    let maxY = b.worldH
    if (componentEditRoots) {
      for (const rid of componentEditRoots) {
        const ids = collectSubtreeIds(nodes, rid)
        const u = unionBoundsWorld(ids, nodes, definitions)
        if (u) {
          maxX = Math.max(maxX, u.right)
          maxY = Math.max(maxY, u.bottom)
        }
      }
    }
    worldW = maxX
    worldH = maxY
  }
  /** Custom layer names by item id; when missing, UI falls back to `itemLabel`. */
  let layerNames: Record<string, string> = {}
  let selected = new Set<string>()
  /** Left sidebar: layer tree vs parent-chain helper (Figma-style hierarchy). */
  let layersAsideTab: 'layers' | 'parent' = 'layers'
  let tool: Tool = 'select'
  let defaultFill = '#a78bfa'
  let defaultStroke = '#4c1d95'
  let defaultStrokeWidth = 2
  let symmetryGuidesOn = true
  let propsPanelFocused = false
  let stylePanelFocused = false
  let defaultOpacity = 1
  let defaultRx = 0
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
      <div class="pop-app-chrome">
        <header class="pop-chrome-titlebar">
          <div class="pop-chrome-title-cluster">
            <h1 class="pop-title">POP</h1>
            <p class="pop-sub" title="Draw on the canvas, add images, then export SVG. Raster images become &lt;image&gt; in the SVG (embedded), not auto-traced.">Shapes, text &amp; images · export SVG/HTML</p>
          </div>
        </header>
        <div class="pop-chrome-ribbon" role="toolbar" aria-label="Editor toolbar">
          <div class="pop-ribbon-group" aria-labelledby="pop-ribbon-lbl-tools">
            <div class="pop-ribbon-group-main pop-ribbon-tools-row" id="pop-tb-tools-panel" role="group" aria-label="Drawing tools">
              <button type="button" class="pop-btn pop-tool pop-ribbon-tool-btn" data-tool="select" aria-pressed="true" title="Move and resize">Select</button>
              <button type="button" class="pop-btn pop-tool pop-ribbon-tool-btn" data-tool="rect" aria-pressed="false" title="Draw a rectangle">Rectangle</button>
              <button type="button" class="pop-btn pop-tool pop-ribbon-tool-btn" data-tool="ellipse" aria-pressed="false" title="Draw an ellipse">Ellipse</button>
              <button type="button" class="pop-btn pop-tool pop-ribbon-tool-btn" data-tool="text" aria-pressed="false" title="Place text">Text</button>
              <button type="button" class="pop-btn pop-tool pop-ribbon-tool-btn" data-tool="image" aria-pressed="false" title="Embed a raster image">Image</button>
            </div>
            <span class="pop-ribbon-group-label" id="pop-ribbon-lbl-tools">Tools</span>
          </div>
          <div class="pop-ribbon-sep" aria-hidden="true"></div>
          <div class="pop-ribbon-group" aria-labelledby="pop-ribbon-lbl-view">
            <div class="pop-ribbon-group-main pop-ribbon-view-block" id="pop-tb-view-panel">
              <div class="pop-ribbon-view-zoom" role="group" aria-label="Canvas zoom">
                <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-out" aria-label="Zoom out">−</button>
                <span class="pop-zoom-pct pop-tb-zoom-readout" id="pop-zoom-pct" aria-live="polite">100%</span>
                <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-in" aria-label="Zoom in">+</button>
              </div>
              <button type="button" class="pop-btn" id="pop-zoom-fit" title="Fit entire canvas in view">Fit</button>
              <button type="button" class="pop-btn" id="pop-zoom-reset" title="Reset zoom and pan to 100%">Reset</button>
            </div>
            <span class="pop-ribbon-group-label" id="pop-ribbon-lbl-view">View</span>
          </div>
          <div class="pop-ribbon-sep" aria-hidden="true"></div>
          <div class="pop-ribbon-group pop-ribbon-group-wide" aria-labelledby="pop-ribbon-lbl-doc">
            <div class="pop-ribbon-group-main pop-ribbon-doc-block" id="pop-tb-doc-panel">
              <div class="pop-ribbon-doc-frame">
                <label class="pop-tb-style-lbl" for="pop-frame-pick">Frame</label>
                <div class="pop-tb-comp-insert-row">
                  <select id="pop-frame-pick" class="pop-comp-pick" aria-label="Active frame"></select>
                  <button type="button" class="pop-btn" id="pop-frame-add" title="Add a new empty frame">+</button>
                </div>
              </div>
              <div class="pop-ribbon-doc-file" role="group" aria-label="Document file">
                <button type="button" class="pop-btn pop-ribbon-file-btn" id="pop-doc-open" title="Load a .json document">Open…</button>
                <button type="button" class="pop-btn pop-primary pop-ribbon-file-btn" id="pop-doc-save" title="Download document as .json">Save</button>
              </div>
            </div>
            <span class="pop-ribbon-group-label" id="pop-ribbon-lbl-doc">File</span>
          </div>
          <div class="pop-ribbon-sep" aria-hidden="true"></div>
          <div class="pop-ribbon-group pop-ribbon-group-wide" aria-labelledby="pop-ribbon-lbl-export">
            <div class="pop-ribbon-group-main" id="pop-tb-export-panel">
              <div class="pop-tb-grid pop-tb-grid-actions pop-ribbon-export-grid" role="group" aria-label="Export SVG">
                <button type="button" class="pop-btn pop-primary pop-tb-grid-btn pop-ribbon-action-compact" id="pop-export-sel">
                  <span class="pop-tb-grid-title">Selection</span>
                  <span class="pop-tb-grid-sub">SVG</span>
                </button>
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-export-all">
                  <span class="pop-tb-grid-title">Frame</span>
                  <span class="pop-tb-grid-sub">SVG</span>
                </button>
              </div>
              <div class="pop-tb-grid pop-tb-grid-actions pop-ribbon-export-grid" role="group" aria-label="Export HTML">
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-export-html">
                  <span class="pop-tb-grid-title">HTML</span>
                  <span class="pop-tb-grid-sub">Frame</span>
                </button>
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-export-html-all">
                  <span class="pop-tb-grid-title">HTML</span>
                  <span class="pop-tb-grid-sub">All frames</span>
                </button>
              </div>
            </div>
            <span class="pop-ribbon-group-label" id="pop-ribbon-lbl-export">Export</span>
          </div>
          <div class="pop-ribbon-sep" aria-hidden="true"></div>
          <div class="pop-ribbon-group pop-ribbon-group-wide" aria-labelledby="pop-ribbon-lbl-arrange">
            <div class="pop-ribbon-group-main" id="pop-tb-arrange-panel">
              <div class="pop-tb-grid pop-tb-grid-actions pop-ribbon-arrange-grid" role="group" aria-label="Group and order">
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-group" disabled>
                  <span class="pop-tb-grid-title">Group</span>
                </button>
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-ungroup" disabled>
                  <span class="pop-tb-grid-title">Ungroup</span>
                </button>
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-bring-front" disabled>
                  <span class="pop-tb-grid-title">Front</span>
                </button>
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-send-back" disabled>
                  <span class="pop-tb-grid-title">Back</span>
                </button>
                <button type="button" class="pop-btn pop-danger pop-tb-grid-btn pop-ribbon-action-compact pop-tb-span2" id="pop-delete" disabled>
                  <span class="pop-tb-grid-title">Delete</span>
                </button>
              </div>
            </div>
            <span class="pop-ribbon-group-label" id="pop-ribbon-lbl-arrange">Arrange</span>
          </div>
          <div class="pop-ribbon-sep" aria-hidden="true"></div>
          <div class="pop-ribbon-group pop-ribbon-group-wide" aria-labelledby="pop-ribbon-lbl-comp">
            <div class="pop-tb-dd-panel pop-tb-comp-panel pop-ribbon-comp-inner" id="pop-tb-comp-panel">
              <button type="button" class="pop-btn pop-primary pop-tb-comp-done" id="pop-comp-done" hidden>
                Done editing
              </button>
              <div class="pop-tb-grid pop-tb-grid-actions pop-ribbon-comp-actions" role="group" aria-label="Components">
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-create-comp" disabled>
                  <span class="pop-tb-grid-title">Create</span>
                  <span class="pop-tb-grid-sub">Component</span>
                </button>
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact" id="pop-detach" disabled>
                  <span class="pop-tb-grid-title">Detach</span>
                </button>
                <button type="button" class="pop-btn pop-tb-grid-btn pop-ribbon-action-compact pop-tb-span2" id="pop-edit-comp" disabled>
                  <span class="pop-tb-grid-title">Edit main</span>
                </button>
              </div>
              <div class="pop-tb-comp-insert pop-ribbon-comp-insert">
                <span class="pop-tb-style-lbl">Insert</span>
                <div class="pop-tb-comp-insert-row">
                  <select id="pop-comp-pick" class="pop-comp-pick" aria-label="Component to insert"></select>
                  <button type="button" class="pop-btn" id="pop-insert-inst">Place</button>
                </div>
              </div>
            </div>
            <span class="pop-ribbon-group-label" id="pop-ribbon-lbl-comp">Components</span>
          </div>
        </div>
        <input type="file" id="pop-file" accept="image/*" hidden />
        <input type="file" id="pop-doc-file" accept="application/json,.json" hidden />
      </div>
      <div class="pop-main">
        <aside class="pop-layers" aria-label="Layers and properties">
          <div class="pop-layer-aside-head">
            <div class="pop-layer-tabs" role="tablist" aria-label="Layer panel">
              <button type="button" class="pop-layer-tab pop-layer-tab-active" role="tab" id="pop-tab-layers" aria-selected="true" aria-controls="pop-layers-tree-panel">Layers</button>
              <button type="button" class="pop-layer-tab" role="tab" id="pop-tab-parent" aria-selected="false" aria-controls="pop-layers-parent-panel" title="See the path from the top of the tree down to the selected layer">Path</button>
            </div>
            <p class="pop-layer-aside-hint" id="pop-layer-aside-hint">Drag to reorder or nest · ⌘/Ctrl+click multi-select</p>
          </div>
          <div id="pop-layers-tree-panel" class="pop-layer-tab-panel" role="tabpanel" aria-labelledby="pop-tab-layers">
            <ul class="pop-layer-list" id="pop-layers" data-pop-layer-tree></ul>
          </div>
          <div id="pop-layers-parent-panel" class="pop-layer-tab-panel" hidden role="tabpanel" aria-labelledby="pop-tab-parent">
            <p class="pop-parent-panel-desc" id="pop-parent-panel-desc">Select a layer to see the path from the root down to it.</p>
            <ol class="pop-parent-chain" id="pop-parent-chain" aria-label="Path from root to selected layer, top to bottom"></ol>
            <button type="button" class="pop-btn pop-btn-block" id="pop-select-siblings" disabled title="Select every layer with the same parent as the current one">Select siblings</button>
          </div>
          <div class="pop-props">
            <h2 class="pop-panel-h">Position</h2>
            <div class="pop-prop-grid" id="pop-prop-grid">
              <label class="pop-field"><span class="pop-field-lbl">X</span><input type="number" id="pop-px" class="pop-num" step="1" disabled /></label>
              <label class="pop-field"><span class="pop-field-lbl">Y</span><input type="number" id="pop-py" class="pop-num" step="1" disabled /></label>
              <label class="pop-field" id="pop-pw-wrap"><span class="pop-field-lbl">W</span><input type="number" id="pop-pw" class="pop-num" step="1" min="1" disabled /></label>
              <label class="pop-field" id="pop-ph-wrap"><span class="pop-field-lbl">H</span><input type="number" id="pop-ph" class="pop-num" step="1" min="1" disabled /></label>
            </div>
            <label class="pop-field pop-field-fs" id="pop-fs-wrap"><span class="pop-field-lbl">Font size</span><input type="number" id="pop-pfs" class="pop-num" step="1" min="4" max="400" disabled /></label>
          </div>
          <div class="pop-props pop-style-section">
            <h2 class="pop-panel-h">Fill &amp; stroke</h2>
            <div class="pop-tb-style-grid">
              <div class="pop-appearance-colors">
                <div class="pop-tb-style-block" id="pop-fill-style-block">
                  <span class="pop-tb-style-lbl">Fill</span>
                  <div class="pop-color-picker">
                    <button type="button" class="pop-color-swatch" id="pop-fill-swatch" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop-fill-panel" title="Fill color"></button>
                    <input type="color" class="pop-color-native" id="pop-fill" value="#a78bfa" tabindex="-1" />
                    <div class="pop-color-panel" id="pop-fill-panel" role="dialog" aria-label="Fill color palette" hidden>
                      <div class="pop-color-panel-cap">Theme colors</div>
                      <div class="pop-color-grid pop-color-grid-theme" id="pop-fill-theme"></div>
                      <div class="pop-color-panel-cap">Standard colors</div>
                      <div class="pop-color-grid pop-color-grid-standard" id="pop-fill-standard"></div>
                      <button type="button" class="pop-btn pop-color-more" id="pop-fill-more">More colors…</button>
                    </div>
                  </div>
                </div>
                <div id="pop-stroke-style-blocks" class="pop-stroke-col">
                  <div class="pop-tb-style-block">
                    <span class="pop-tb-style-lbl">Stroke</span>
                    <div class="pop-color-picker">
                      <button type="button" class="pop-color-swatch" id="pop-stroke-swatch" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop-stroke-panel" title="Stroke color"></button>
                      <input type="color" class="pop-color-native" id="pop-stroke" value="#4c1d95" tabindex="-1" />
                      <div class="pop-color-panel" id="pop-stroke-panel" role="dialog" aria-label="Stroke color palette" hidden>
                        <div class="pop-color-panel-cap">Theme colors</div>
                        <div class="pop-color-grid pop-color-grid-theme" id="pop-stroke-theme"></div>
                        <div class="pop-color-panel-cap">Standard colors</div>
                        <div class="pop-color-grid pop-color-grid-standard" id="pop-stroke-standard"></div>
                        <button type="button" class="pop-btn pop-color-more" id="pop-stroke-more">More colors…</button>
                      </div>
                    </div>
                  </div>
                  <label class="pop-tb-style-block pop-tb-stroke-w">
                    <span class="pop-tb-style-lbl">Width</span>
                    <input type="range" id="pop-stroke-w" min="0" max="12" value="2" aria-label="Stroke width" />
                  </label>
                </div>
              </div>
              <div class="pop-appearance-sliders">
                <label class="pop-tb-style-block pop-tb-opacity">
                  <span class="pop-tb-style-lbl">Opacity</span>
                  <input type="range" id="pop-opacity" min="0" max="100" value="100" aria-label="Opacity" />
                </label>
                <label class="pop-tb-style-block pop-tb-rx" id="pop-rx-wrap">
                  <span class="pop-tb-style-lbl">Radius</span>
                  <input type="range" id="pop-rx" min="0" max="80" value="0" aria-label="Corner radius" />
                </label>
              </div>
            </div>
          </div>
          <div class="pop-props" id="pop-typography-props" hidden>
            <h2 class="pop-panel-h">Text</h2>
            <label class="pop-field pop-field-fs"><span class="pop-field-lbl">Font</span><input type="text" id="pop-font-family" class="pop-num" spellcheck="false" /></label>
            <div class="pop-prop-grid">
              <label class="pop-field"><span class="pop-field-lbl">Weight</span><input type="number" id="pop-font-weight" class="pop-num" min="100" max="900" step="100" /></label>
              <label class="pop-field"><span class="pop-field-lbl">Tracking</span><input type="number" id="pop-letter-spacing" class="pop-num" step="0.5" /></label>
            </div>
            <label class="pop-field pop-field-fs"><span class="pop-field-lbl">Line height</span><input type="number" id="pop-line-height" class="pop-num" min="0.5" max="3" step="0.05" /></label>
          </div>
          <div class="pop-props" id="pop-group-layout-props" hidden>
            <h2 class="pop-panel-h">HTML: children in group</h2>
            <p class="pop-panel-desc" id="pop-group-layout-desc">
              Canvas stays the same. This only changes the exported HTML/CSS: either keep each child’s position, or lay children out with flexbox (stack).
            </p>
            <label class="pop-field pop-field-fs"><span class="pop-field-lbl">Layout</span>
              <select id="pop-group-layout" aria-label="How children are arranged in exported HTML" aria-describedby="pop-group-layout-desc">
                <option value="none">Freeform — absolute positions</option>
                <option value="stack-v">Vertical stack (flex column)</option>
                <option value="stack-h">Horizontal stack (flex row)</option>
              </select>
            </label>
            <div class="pop-prop-grid">
              <label class="pop-field"><span class="pop-field-lbl">Gap</span><input type="number" id="pop-group-gap" class="pop-num" min="0" step="1" /></label>
              <label class="pop-field"><span class="pop-field-lbl">Pad</span><input type="number" id="pop-group-pad" class="pop-num" min="0" step="1" /></label>
            </div>
          </div>
          <div class="pop-props pop-props-tight">
            <div class="pop-symmetry">
              <label class="pop-check"><input type="checkbox" id="pop-guides" checked /><span>Guides &amp; snap</span></label>
              <p class="pop-hint" id="pop-sym-hint"></p>
            </div>
          </div>
        </aside>
        <div class="pop-canvas-wrap" title="⌘+scroll to pan · Ctrl+scroll or pinch to zoom toward the pointer">
          <svg class="pop-canvas" id="pop-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}" role="img" aria-label="Design canvas">
            <g id="pop-viewport" transform="translate(0 0) scale(1)">
              <rect class="pop-canvas-bg" id="pop-canvas-bg" x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" fill="transparent" pointer-events="none"/>
              <g id="pop-frame-outlines" pointer-events="none"></g>
              <g id="pop-guides-back" pointer-events="none"></g>
              <g id="pop-items"></g>
              <g id="pop-handles"></g>
              <g id="pop-guides-front" pointer-events="none"></g>
            </g>
          </svg>
          <div class="pop-zoom-dock" role="toolbar" aria-label="Canvas zoom">
            <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-out-dock" aria-label="Zoom out" title="Zoom out">−</button>
            <span class="pop-zoom-pct pop-zoom-dock-readout" id="pop-zoom-pct-dock" aria-live="polite">100%</span>
            <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-in-dock" aria-label="Zoom in" title="Zoom in">+</button>
            <button type="button" class="pop-btn pop-zoom-dock-fit" id="pop-zoom-fit-dock" title="Fit entire canvas in view">Fit</button>
            <button type="button" class="pop-btn pop-zoom-dock-reset" id="pop-zoom-reset-dock" title="Reset zoom to 100% and pan">100%</button>
          </div>
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
  const tabLayersBtn = root.querySelector<HTMLButtonElement>('#pop-tab-layers')!
  const tabParentBtn = root.querySelector<HTMLButtonElement>('#pop-tab-parent')!
  const layersTreePanel = root.querySelector<HTMLElement>('#pop-layers-tree-panel')!
  const layersParentPanel = root.querySelector<HTMLElement>('#pop-layers-parent-panel')!
  const parentPanelDesc = root.querySelector<HTMLParagraphElement>('#pop-parent-panel-desc')!
  const parentChainEl = root.querySelector<HTMLOListElement>('#pop-parent-chain')!
  const layerAsideHint = root.querySelector<HTMLParagraphElement>('#pop-layer-aside-hint')!
  const btnSelectSiblings = root.querySelector<HTMLButtonElement>('#pop-select-siblings')!
  const fileInput = root.querySelector<HTMLInputElement>('#pop-file')!
  const fillInput = root.querySelector<HTMLInputElement>('#pop-fill')!
  const strokeInput = root.querySelector<HTMLInputElement>('#pop-stroke')!
  const strokeWInput = root.querySelector<HTMLInputElement>('#pop-stroke-w')!
  const btnExportSel = root.querySelector<HTMLButtonElement>('#pop-export-sel')!
  const btnExportAll = root.querySelector<HTMLButtonElement>('#pop-export-all')!
  const btnDelete = root.querySelector<HTMLButtonElement>('#pop-delete')!
  const btnGroup = root.querySelector<HTMLButtonElement>('#pop-group')!
  const btnUngroup = root.querySelector<HTMLButtonElement>('#pop-ungroup')!
  const btnBringFront = root.querySelector<HTMLButtonElement>('#pop-bring-front')!
  const btnSendBack = root.querySelector<HTMLButtonElement>('#pop-send-back')!
  const btnCreateComp = root.querySelector<HTMLButtonElement>('#pop-create-comp')!
  const btnDetach = root.querySelector<HTMLButtonElement>('#pop-detach')!
  const btnEditComp = root.querySelector<HTMLButtonElement>('#pop-edit-comp')!
  const selCompPick = root.querySelector<HTMLSelectElement>('#pop-comp-pick')!
  const btnInsertInst = root.querySelector<HTMLButtonElement>('#pop-insert-inst')!
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
  const opacityInput = root.querySelector<HTMLInputElement>('#pop-opacity')!
  const rxInput = root.querySelector<HTMLInputElement>('#pop-rx')!
  const strokeStyleBlocks = root.querySelector<HTMLElement>('#pop-stroke-style-blocks')!
  const fillStyleBlock = root.querySelector<HTMLElement>('#pop-fill-style-block')!
  const rxWrap = root.querySelector<HTMLElement>('#pop-rx-wrap')!
  const styleSection = root.querySelector<HTMLElement>('.pop-style-section')!
  const btnZoomIn = root.querySelector<HTMLButtonElement>('#pop-zoom-in')!
  const btnZoomOut = root.querySelector<HTMLButtonElement>('#pop-zoom-out')!
  const btnZoomReset = root.querySelector<HTMLButtonElement>('#pop-zoom-reset')!
  const btnZoomFit = root.querySelector<HTMLButtonElement>('#pop-zoom-fit')!
  const elZoomPct = root.querySelector<HTMLElement>('#pop-zoom-pct')!
  const btnZoomInDock = root.querySelector<HTMLButtonElement>('#pop-zoom-in-dock')!
  const btnZoomOutDock = root.querySelector<HTMLButtonElement>('#pop-zoom-out-dock')!
  const btnZoomResetDock = root.querySelector<HTMLButtonElement>('#pop-zoom-reset-dock')!
  const btnZoomFitDock = root.querySelector<HTMLButtonElement>('#pop-zoom-fit-dock')!
  const elZoomPctDock = root.querySelector<HTMLElement>('#pop-zoom-pct-dock')!
  const canvasBgEl = root.querySelector<SVGRectElement>('#pop-canvas-bg')!
  const frameOutlinesG = root.querySelector<SVGGElement>('#pop-frame-outlines')!
  const popFramePick = root.querySelector<HTMLSelectElement>('#pop-frame-pick')!
  const btnFrameAdd = root.querySelector<HTMLButtonElement>('#pop-frame-add')!
  const btnDocOpen = root.querySelector<HTMLButtonElement>('#pop-doc-open')!
  const btnDocSave = root.querySelector<HTMLButtonElement>('#pop-doc-save')!
  const docFileInput = root.querySelector<HTMLInputElement>('#pop-doc-file')!
  const btnExportHtml = root.querySelector<HTMLButtonElement>('#pop-export-html')!
  const btnExportHtmlAll = root.querySelector<HTMLButtonElement>('#pop-export-html-all')!
  const typographyProps = root.querySelector<HTMLElement>('#pop-typography-props')!
  const inpFontFamily = root.querySelector<HTMLInputElement>('#pop-font-family')!
  const inpFontWeight = root.querySelector<HTMLInputElement>('#pop-font-weight')!
  const inpLetterSpacing = root.querySelector<HTMLInputElement>('#pop-letter-spacing')!
  const inpLineHeight = root.querySelector<HTMLInputElement>('#pop-line-height')!
  const groupLayoutProps = root.querySelector<HTMLElement>('#pop-group-layout-props')!
  const selGroupLayout = root.querySelector<HTMLSelectElement>('#pop-group-layout')!
  const inpGroupGap = root.querySelector<HTMLInputElement>('#pop-group-gap')!
  const inpGroupPad = root.querySelector<HTMLInputElement>('#pop-group-pad')!
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
      const t = ev.target as Node
      if (!openColorPicker) return
      if (openColorPicker.panel.contains(t) || openColorPicker.swatch.contains(t)) return
      closeColorPickerPanel()
    },
    true,
  )

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeColorPickerPanel()
    }
  })

  window.addEventListener('resize', () => {
    closeColorPickerPanel()
  })
  window.addEventListener(
    'scroll',
    () => {
      closeColorPickerPanel()
    },
    true,
  )

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  /** ~1 screen pixel per world unit, for hairline strokes that match the CSS grid weight. */
  function getScreenPxPerWorldUnit(): number {
    const ctm = viewportG.getScreenCTM()
    if (!ctm) return 1
    const p0 = svg.createSVGPoint()
    p0.x = 0
    p0.y = 0
    const p1 = svg.createSVGPoint()
    p1.x = 1
    p1.y = 0
    const s0 = p0.matrixTransform(ctm)
    const s1 = p1.matrixTransform(ctm)
    return Math.max(Math.hypot(s1.x - s0.x, s1.y - s0.y), 1e-6)
  }

  /** Scale symmetry + snap guide strokes with zoom so they match the workspace grid (hairline on screen). */
  function syncGuidePresentation(): void {
    const px = getScreenPxPerWorldUnit()
    const hair = 1 / px
    const snapStroke = Math.max(hair * 1.5, 0.001)
    const dash = 8 / px
    const gap = 6 / px
    const dashStr = `${dash} ${gap}`
    guidesBack.querySelectorAll('line').forEach((el) => {
      el.setAttribute('stroke-width', String(hair))
      el.setAttribute('stroke-dasharray', dashStr)
      el.removeAttribute('vector-effect')
    })
    guidesFront.querySelectorAll('line').forEach((el) => {
      el.setAttribute('stroke-width', String(snapStroke))
      el.removeAttribute('stroke-dasharray')
      el.removeAttribute('vector-effect')
    })
  }

  function syncWorkspaceChrome(): void {
    syncCanvasWorkspaceGrid()
    syncGuidePresentation()
  }

  /** One workspace grid: CSS on canvas-wrap, aligned to world space via viewport CTM (pan/zoom/letterbox). */
  function syncCanvasWorkspaceGrid(): void {
    const ctm = viewportG.getScreenCTM()
    if (!ctm) return
    const worldToScreen = (wx: number, wy: number): { x: number; y: number } => {
      const pt = svg.createSVGPoint()
      pt.x = wx
      pt.y = wy
      const sp = pt.matrixTransform(ctm)
      return { x: sp.x, y: sp.y }
    }
    const p0 = worldToScreen(0, 0)
    const px = worldToScreen(GRID_PATTERN_WORLD, 0)
    const py = worldToScreen(0, GRID_PATTERN_WORLD)
    const pitchX = Math.hypot(px.x - p0.x, px.y - p0.y)
    const pitchY = Math.hypot(py.x - p0.x, py.y - p0.y)
    const pitch = Math.max((pitchX + pitchY) / 2, 0.75)

    const wrap = canvasWrap.getBoundingClientRect()
    const relX = p0.x - wrap.left
    const relY = p0.y - wrap.top
    const mod = (n: number, m: number): number => ((n % m) + m) % m
    const ox = -mod(relX, pitch)
    const oy = -mod(relY, pitch)

    canvasWrap.style.setProperty('--pop-grid-pitch', `${pitch}px`)
    canvasWrap.style.setProperty('--pop-grid-ox', `${ox}px`)
    canvasWrap.style.setProperty('--pop-grid-oy', `${oy}px`)
  }

  function syncViewportTransform(): void {
    viewportG.setAttribute('transform', `translate(${viewTx} ${viewTy}) scale(${viewScale})`)
    syncWorkspaceChrome()
  }

  function updateZoomPctLabel(): void {
    const t = `${Math.round(viewScale * 100)}%`
    elZoomPct.textContent = t
    elZoomPctDock.textContent = t
  }

  /** Scale and pan so the full world bounds fit inside the visible SVG with padding. */
  function zoomToFitCanvas(): void {
    const pad = 40
    const sb = svg.getBoundingClientRect()
    const aw = Math.max(64, sb.width - pad)
    const ah = Math.max(64, sb.height - pad)
    const ww = Math.max(1, worldW)
    const wh = Math.max(1, worldH)
    const ns = clamp(Math.min(aw / ww, ah / wh), MIN_VIEW_SCALE, MAX_VIEW_SCALE)
    const wc = ww / 2
    const hc = wh / 2
    viewScale = ns
    viewTx = 0
    viewTy = 0
    syncViewportTransform()
    const cx = sb.left + sb.width / 2
    const cy = sb.top + sb.height / 2
    const w = clientToSvgCoords(cx, cy)
    viewTx = viewScale * (w.x - wc)
    viewTy = viewScale * (w.y - hc)
    syncViewportTransform()
    updateZoomPctLabel()
    schedulePersist()
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

  function buildDocumentV3(): PopDocumentV3 {
    return {
      v: 3,
      meta: { name: docName, updatedAt: new Date().toISOString() },
      tokens,
      frames: JSON.parse(JSON.stringify(frames)) as PopFrame[],
      activeFrameId,
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
    }
  }

  function persistToStorage(): void {
    try {
      localStorage.setItem(STORAGE_KEY_V3, JSON.stringify(buildDocumentV3()))
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

  function applyDocumentV3(doc: PopDocumentV3): void {
    docName = doc.meta.name
    tokens = doc.tokens ?? {}
    frames = JSON.parse(JSON.stringify(doc.frames)) as PopFrame[]
    activeFrameId = doc.activeFrameId
    if (!frames.some((f) => f.id === activeFrameId)) activeFrameId = frames[0]!.id
    nodes = recordToNodes(doc.nodes as Record<string, unknown>)
    definitions = recordToDefs(doc.definitions as Record<string, unknown>)
    layerNames = { ...doc.layerNames }
    defaultFill = doc.defaultFill
    defaultStroke = doc.defaultStroke
    defaultStrokeWidth = doc.defaultStrokeWidth
    symmetryGuidesOn = doc.symmetryGuidesOn
    fillInput.value = defaultFill
    strokeInput.value = defaultStroke
    strokeWInput.value = String(defaultStrokeWidth)
    guidesCheckbox.checked = symmetryGuidesOn
    componentEditRoots = null
    editingComponentId = null
    applyLoadedView(doc)
    const keepIds = new Set(nodes.keys())
    for (const k of Object.keys(layerNames)) {
      if (!keepIds.has(k)) delete layerNames[k]
    }
    recomputeWorldSize()
  }

  try {
    const rawV3 = localStorage.getItem(STORAGE_KEY_V3)
    if (rawV3) {
      const parsed = JSON.parse(rawV3) as unknown
      const doc = loadDocumentV3(parsed)
      if (doc) applyDocumentV3(doc)
    } else {
      const rawV2 = localStorage.getItem(STORAGE_KEY_V2)
      if (rawV2) {
        const data = JSON.parse(rawV2) as Partial<PersistedStateV2>
        if (data.v === 2 && data.nodes && typeof data.nodes === 'object' && Array.isArray(data.rootIds)) {
          const v2: PersistedStateV2 = {
            v: 2,
            rootIds: data.rootIds,
            nodes: data.nodes as PersistedStateV2['nodes'],
            layerNames: (data.layerNames as PersistedStateV2['layerNames']) ?? {},
            definitions: (data.definitions as PersistedStateV2['definitions']) ?? {},
            defaultFill: data.defaultFill ?? '#3b82f6',
            defaultStroke: data.defaultStroke ?? '#1e3a5f',
            defaultStrokeWidth: data.defaultStrokeWidth ?? 2,
            symmetryGuidesOn: data.symmetryGuidesOn ?? true,
            viewTx: data.viewTx,
            viewTy: data.viewTy,
            viewScale: data.viewScale,
          }
          applyDocumentV3(migrateV2ToV3(v2))
          persistToStorage()
        }
      } else {
        const rawV1 = localStorage.getItem(STORAGE_KEY_V1)
        if (rawV1) {
          const data = JSON.parse(rawV1) as Partial<PersistedStateV1>
          if (data.v === 1 && Array.isArray(data.items)) {
            const next = data.items.filter(isValidCanvasItem)
            const mig = migrateV1ToScene(next)
            const v2: PersistedStateV2 = {
              v: 2,
              rootIds: mig.rootIds,
              nodes: nodesToRecord(mig.nodes),
              layerNames:
                data.layerNames && typeof data.layerNames === 'object' ? { ...data.layerNames } : {},
              definitions: {},
              defaultFill: data.defaultFill ?? '#3b82f6',
              defaultStroke: data.defaultStroke ?? '#1e3a5f',
              defaultStrokeWidth: data.defaultStrokeWidth ?? 2,
              symmetryGuidesOn: data.symmetryGuidesOn ?? true,
              viewTx: data.viewTx,
              viewTy: data.viewTy,
              viewScale: data.viewScale,
            }
            applyDocumentV3(migrateV2ToV3(v2))
            persistToStorage()
          }
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

  function clampRectCornerRadius(it: SceneNode): void {
    if (it.type !== 'rect') return
    const maxR = Math.min(it.width, it.height) / 2
    it.rx = Math.max(0, Math.min(it.rx, maxR))
  }

  function syncStyleFromSelection(): void {
    const n = selected.size
    const sel = [...selected]

    const anyFillTarget =
      n === 0 || sel.some((id) => ['rect', 'ellipse', 'text'].includes(getNode(id)?.type ?? ''))
    const anyStrokeTarget =
      n === 0 || sel.some((id) => ['rect', 'ellipse'].includes(getNode(id)?.type ?? ''))
    const anyOpacityTarget =
      n === 0 ||
      sel.some((id) => ['rect', 'ellipse', 'text', 'image'].includes(getNode(id)?.type ?? ''))
    const anyRect = n === 0 || sel.some((id) => getNode(id)?.type === 'rect')

    fillInput.disabled = n > 0 && !anyFillTarget
    fillSwatch.disabled = fillInput.disabled
    fillStyleBlock.style.opacity = n > 0 && !anyFillTarget ? '0.45' : ''

    strokeStyleBlocks.hidden = n > 0 && !anyStrokeTarget
    strokeInput.disabled = n > 0 && !anyStrokeTarget
    strokeWInput.disabled = n > 0 && !anyStrokeTarget
    strokeSwatch.disabled = strokeInput.disabled

    opacityInput.disabled = n > 0 && !anyOpacityTarget
    rxWrap.style.display = anyRect ? '' : 'none'
    rxInput.disabled = n > 0 && !anyRect

    if (n === 0) {
      fillInput.value = defaultFill
      strokeInput.value = defaultStroke
      strokeWInput.value = String(defaultStrokeWidth)
      opacityInput.value = String(Math.round(defaultOpacity * 100))
      rxInput.value = String(Math.round(defaultRx))
      updateBothSwatches()
      return
    }

    const fillIds = sel.filter((id) => ['rect', 'ellipse', 'text'].includes(getNode(id)?.type ?? ''))
    if (fillIds.length > 0) {
      const hexes = fillIds.map((id) => normalizeHex6((getNode(id) as { fill: string }).fill))
      const first = hexes[0]!
      fillInput.value = first
      fillSwatch.title = hexes.every((h) => h === first) ? `Fill: ${first}` : `Mixed fills (${first} shown)`
      updateFillSwatch()
    }

    const strokeIds = sel.filter((id) => ['rect', 'ellipse'].includes(getNode(id)?.type ?? ''))
    if (!strokeStyleBlocks.hidden && strokeIds.length > 0) {
      const strokes = strokeIds.map((id) => normalizeHex6((getNode(id) as { stroke: string }).stroke))
      const sw = strokeIds.map((id) => (getNode(id) as { strokeWidth: number }).strokeWidth)
      const s0 = strokes[0]!
      strokeInput.value = s0
      strokeSwatch.title = strokes.every((s) => s === s0) ? `Stroke: ${s0}` : `Mixed strokes (${s0} shown)`
      updateStrokeSwatch()
      if (sw.every((w) => w === sw[0])) strokeWInput.value = String(sw[0])
      else strokeWInput.value = String(sw[0])
    }

    const opLeaves = sel
      .map((id) => getNode(id))
      .filter(
        (it): it is SceneLeaf =>
          !!it && (it.type === 'rect' || it.type === 'ellipse' || it.type === 'text' || it.type === 'image'),
      )
    if (opLeaves.length > 0) {
      const ops = opLeaves.map((it) => it.opacity)
      const o0 = ops[0]!
      opacityInput.value = String(Math.round(o0 * 100))
      if (!ops.every((o) => o === o0)) opacityInput.title = 'Mixed opacity (first shown)'
      else opacityInput.title = 'Opacity'
    }

    const rects = sel
      .map((id) => getNode(id))
      .filter((it): it is SceneNode & { type: 'rect' } => it?.type === 'rect')
    if (rects.length > 0) {
      const rxs = rects.map((r) => r.rx)
      const r0 = rxs[0]!
      rxInput.value = String(Math.round(r0))
      if (!rxs.every((r) => r === r0)) rxInput.title = 'Mixed corner radius (first shown)'
      else rxInput.title = 'Corner radius'
    }
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
      const it = getNode([...selected][0]!)!
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
      } else if (it.type === 'group' || it.type === 'instance') {
        inpFs.disabled = true
        fsWrap.style.display = 'none'
        pwWrap.style.display = ''
        phWrap.style.display = ''
        inpW.value = String(stripNum(it.width))
        inpH.value = String(stripNum(it.height))
        inpFs.value = ''
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
    const ws = [...selected].map((id) => getNode(id)!.width)
    const hs = [...selected].map((id) => getNode(id)!.height)
    inpW.value = ws.every((w) => w === ws[0]) ? String(stripNum(ws[0]!)) : ''
    inpH.value = hs.every((h) => h === hs[0]) ? String(stripNum(hs[0]!)) : ''
  }

  function stripNum(n: number): number {
    return Math.round(n * 1000) / 1000
  }

  function scaleGroupChildren(gid: string, sx: number, sy: number): void {
    const g = nodes.get(gid)
    if (g?.type !== 'group') return
    for (const cid of g.childIds) {
      const c = nodes.get(cid)
      if (!c) continue
      c.x *= sx
      c.y *= sy
      c.width *= sx
      c.height *= sy
      if (c.type === 'text') {
        c.fontSize = clamp(Math.round(c.fontSize * Math.min(sx, sy)), 4, 400)
        c.height = c.fontSize
      }
      if (c.type === 'rect') {
        const factor = Math.min(sx, sy)
        c.rx = stripNum(Math.min(c.rx * factor, c.width / 2, c.height / 2))
      }
      if (c.type === 'group') {
        scaleGroupChildren(cid, sx, sy)
      }
    }
  }

  function applyTransformFromInputs(): void {
    if (selected.size === 0) return
    if (selected.size === 1) {
      const it = getNode([...selected][0]!)!
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
      } else if (it.type === 'group') {
        const pw = readNum(inpW)
        const ph = readNum(inpH)
        const ow = it.width
        const oh = it.height
        if (pw !== null && ph !== null) {
          const nw = Math.max(1, pw)
          const nh = Math.max(1, ph)
          scaleGroupChildren(it.id, nw / ow, nh / oh)
          it.width = nw
          it.height = nh
        } else if (pw !== null) {
          const nw = Math.max(1, pw)
          scaleGroupChildren(it.id, nw / ow, 1)
          it.width = nw
        } else if (ph !== null) {
          const nh = Math.max(1, ph)
          scaleGroupChildren(it.id, 1, nh / oh)
          it.height = nh
        }
      } else {
        const pw = readNum(inpW)
        const ph = readNum(inpH)
        if (pw !== null) it.width = Math.max(1, pw)
        if (ph !== null) it.height = Math.max(1, ph)
        if (it.type === 'rect') clampRectCornerRadius(it)
      }
    } else {
      const pw = readNum(inpW)
      const ph = readNum(inpH)
      if (pw !== null) {
        for (const id of selected) {
          const it = getNode(id)
          if (it && it.type === 'group') {
            const ow = it.width
            const nw = Math.max(1, pw)
            scaleGroupChildren(it.id, nw / ow, 1)
            it.width = nw
          } else if (it && it.type !== 'text') {
            it.width = Math.max(1, pw)
            if (it.type === 'rect') clampRectCornerRadius(it)
          }
        }
      }
      if (ph !== null) {
        for (const id of selected) {
          const it = getNode(id)
          if (it && it.type === 'group') {
            const oh = it.height
            const nh = Math.max(1, ph)
            scaleGroupChildren(it.id, 1, nh / oh)
            it.height = nh
          } else if (it && it.type !== 'text') {
            it.height = Math.max(1, ph)
            if (it.type === 'rect') clampRectCornerRadius(it)
          }
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
      l.setAttribute('stroke', '#c4b5fd')
      l.setAttribute('stroke-opacity', '0.35')
      l.setAttribute('stroke-width', '1')
      return l
    }
    const b = snapBoundsForFrame()
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    // Span the full world so guides stay consistent when panning/zooming (same as snap preview lines).
    guidesBack.appendChild(mkLine(cx, 0, cx, worldH))
    guidesBack.appendChild(mkLine(0, cy, worldW, cy))
    syncGuidePresentation()
  }

  function renderSnapGuides(verticalX: number | null, horizontalY: number | null): void {
    guidesFront.replaceChildren()
    if (verticalX !== null) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      l.setAttribute('x1', String(verticalX))
      l.setAttribute('x2', String(verticalX))
      l.setAttribute('y1', '0')
      l.setAttribute('y2', String(worldH))
      l.setAttribute('stroke', '#c4d0ff')
      l.setAttribute('stroke-width', '1')
      guidesFront.appendChild(l)
    }
    if (horizontalY !== null) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      l.setAttribute('x1', '0')
      l.setAttribute('x2', String(worldW))
      l.setAttribute('y1', String(horizontalY))
      l.setAttribute('y2', String(horizontalY))
      l.setAttribute('stroke', '#c4d0ff')
      l.setAttribute('stroke-width', '1')
      guidesFront.appendChild(l)
    }
    syncGuidePresentation()
  }

  for (const el of [inpX, inpY, inpW, inpH, inpFs]) {
    el.addEventListener('focus', () => {
      propsPanelFocused = true
    })
    el.addEventListener('blur', () => {
      propsPanelFocused = false
      syncPropsFromSelection()
      if (!stylePanelFocused) syncStyleFromSelection()
    })
    el.addEventListener('input', () => applyTransformFromInputs())
  }

  styleSection.addEventListener('focusin', () => {
    stylePanelFocused = true
  })
  styleSection.addEventListener('focusout', (e) => {
    const rt = e.relatedTarget as Node | null
    if (rt && styleSection.contains(rt)) return
    if (rt && (fillPanel.contains(rt) || strokePanel.contains(rt))) return
    stylePanelFocused = false
    syncStyleFromSelection()
  })

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
    defaultOpacity = clamp(Number(opacityInput.value) / 100, 0, 1)
    defaultRx = Math.max(0, Number(rxInput.value))
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
      const r = roots()
      const j = r.indexOf(childId)
      if (j >= 0) r.splice(j, 1)
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
      const r = roots()
      const i = clamp(index, 0, r.length)
      r.splice(i, 0, childId)
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

  function additiveMultiSelect(ev: MouseEvent | PointerEvent): boolean {
    return ev.shiftKey || ev.metaKey || ev.ctrlKey
  }

  /** Depth from root (1 = canvas root). Used to pick a primary node when several are selected. */
  function depthFromRoot(id: string): number {
    let d = 0
    let c: string | null = id
    while (c) {
      d++
      c = nodes.get(c)?.parentId ?? null
    }
    return d
  }

  function primarySelectionId(): string | null {
    if (selected.size === 0) return null
    if (selected.size === 1) return [...selected][0]!
    let best: string | null = null
    let bestDepth = -1
    for (const id of selected) {
      const d = depthFromRoot(id)
      if (d > bestDepth) {
        bestDepth = d
        best = id
      }
    }
    return best
  }

  function ancestorChainOrdered(id: string): string[] {
    const chain: string[] = []
    let c: string | null = id
    while (c) {
      chain.push(c)
      c = nodes.get(c)?.parentId ?? null
    }
    return chain.reverse()
  }

  function setLayersAsideTab(tab: 'layers' | 'parent'): void {
    layersAsideTab = tab
    const layersOn = tab === 'layers'
    tabLayersBtn.classList.toggle('pop-layer-tab-active', layersOn)
    tabLayersBtn.setAttribute('aria-selected', String(layersOn))
    tabParentBtn.classList.toggle('pop-layer-tab-active', !layersOn)
    tabParentBtn.setAttribute('aria-selected', String(!layersOn))
    layersTreePanel.hidden = !layersOn
    layersParentPanel.hidden = layersOn
    layerAsideHint.textContent = layersOn
      ? 'Drag to reorder or nest · ⌘/Ctrl+click multi-select'
      : 'Top → bottom is root to selection. Click a row to select that layer.'
    if (!layersOn) renderParentPanel()
  }

  function renderParentPanel(): void {
    parentChainEl.replaceChildren()
    const prim = primarySelectionId()
    if (!prim) {
      parentPanelDesc.textContent = 'Select a layer on the canvas or in the Layers list.'
      btnSelectSiblings.disabled = true
      return
    }
    btnSelectSiblings.disabled = false
    const chain = ancestorChainOrdered(prim)
    parentPanelDesc.textContent =
      chain.length > 1
        ? 'Ancestors above, selection last. Click any row to select that layer.'
        : 'Nothing is nested above this layer (it is a direct child of the frame or root).'
    for (const cid of chain) {
      const item = getNode(cid)
      if (!item) continue
      const li = document.createElement('li')
      li.className = 'pop-parent-crumb'
      if (selected.has(cid)) li.classList.add('pop-parent-crumb-selected')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pop-parent-crumb-btn'
      btn.textContent = layerNames[cid] ?? itemLabel(item, definitions)
      btn.addEventListener('click', () => {
        selected = new Set([cid])
        updateSelectionUi()
        syncPropsFromSelection()
        syncStyleFromSelection()
        renderHandles()
        renderParentPanel()
      })
      li.appendChild(btn)
      parentChainEl.appendChild(li)
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
      const subtree = collectSubtreeIds(nodes, id)
      removeChildRef(n.parentId, id)
      for (const x of subtree) {
        nodes.delete(x)
        delete layerNames[x]
        selected.delete(x)
      }
    }
  }

  function buildCopyPayload(): PopClipboardPayload | null {
    const roots = selectedDeletionRoots()
    if (roots.length === 0) return null
    const idSet = new Set<string>()
    for (const r of roots) {
      for (const id of collectSubtreeIds(nodes, r)) idSet.add(id)
    }
    const nodesOut: Record<string, SceneNode> = {}
    for (const id of idSet) {
      const raw = nodes.get(id)
      if (!raw) continue
      const copy = JSON.parse(JSON.stringify(raw)) as SceneNode
      const p = raw.parentId
      if (p !== null && !idSet.has(p)) {
        const wf = worldFrame(nodes, definitions, id)
        if (!wf) continue
        copy.parentId = null
        copy.x = wf.x
        copy.y = wf.y
        copy.width = wf.width
        copy.height = wf.height
        if (copy.type === 'text') {
          copy.height = wf.height
        }
      }
      nodesOut[id] = copy
    }
    const layerNamesOut: Record<string, string> = {}
    for (const id of idSet) {
      const ln = layerNames[id]
      if (ln) layerNamesOut[id] = ln
    }
    return {
      popClipboard: POP_CLIPBOARD_VERSION,
      roots: [...roots],
      nodes: nodesOut,
      layerNames: Object.keys(layerNamesOut).length > 0 ? layerNamesOut : undefined,
    }
  }

  async function copySelectionToSystemClipboard(): Promise<void> {
    const payload = buildCopyPayload()
    if (!payload) return
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload))
    } catch {
      /* clipboard may be unavailable */
    }
  }

  function pastePayloadIntoDocument(payload: PopClipboardPayload): void {
    const oldIds = Object.keys(payload.nodes)
    if (oldIds.length === 0 || payload.roots.length === 0) return
    const idMap = new Map<string, string>()
    for (const oid of oldIds) {
      idMap.set(oid, newId())
    }
    for (const oid of oldIds) {
      const raw = payload.nodes[oid]
      if (!raw) continue
      const nid = idMap.get(oid)!
      const copy = JSON.parse(JSON.stringify(raw)) as SceneNode
      copy.id = nid
      const p = raw.parentId
      copy.parentId = p === null ? null : idMap.get(p)!
      if (copy.type === 'group' && raw.type === 'group') {
        copy.childIds = raw.childIds.map((c) => idMap.get(c)!)
      }
      nodes.set(nid, copy)
    }

    const tops = selectedDeletionRoots()
    let pasteParent: string | null
    let insertAt: number
    if (tops.length === 0) {
      pasteParent = null
      insertAt = roots().length
    } else {
      const first = nodes.get(tops[0]!)
      pasteParent = first?.parentId ?? null
      const sib = siblingListForParent(pasteParent)
      const indices = tops.map((id) => sib.indexOf(id)).filter((i) => i >= 0)
      insertAt = indices.length > 0 ? Math.max(...indices) + 1 : sib.length
    }

    const newSelection: string[] = []
    let slot = insertAt
    for (const oldRoot of payload.roots) {
      const newId = idMap.get(oldRoot)
      if (!newId) continue
      const n = nodes.get(newId)
      if (!n) continue

      removeChildRef(n.parentId, newId)

      const wf = worldFrame(nodes, definitions, newId)
      if (!wf) {
        insertChildRef(pasteParent, newId, slot++)
        newSelection.push(newId)
        continue
      }
      const ox = worldSpaceOriginForParent(pasteParent)
      n.x = wf.x + PASTE_OFFSET_WORLD - ox.x
      n.y = wf.y + PASTE_OFFSET_WORLD - ox.y

      insertChildRef(pasteParent, newId, slot++)
      newSelection.push(newId)
    }

    for (const [oid, nid] of idMap) {
      const nm = payload.layerNames?.[oid]
      if (nm) layerNames[nid] = nm
    }

    selected = new Set(newSelection)
    commit()
  }

  async function pasteFromSystemClipboard(): Promise<void> {
    let raw: string
    try {
      raw = await navigator.clipboard.readText()
    } catch {
      return
    }
    const payload = parsePopClipboard(raw)
    if (!payload) return
    pastePayloadIntoDocument(payload)
  }

  function groupSelection(): void {
    const ids = [...selected]
    if (ids.length < 2) return
    const parentId = nodes.get(ids[0]!)?.parentId ?? null
    if (!ids.every((id) => (nodes.get(id)?.parentId ?? null) === parentId)) {
      alert('Select layers that share the same parent to group.')
      return
    }
    const u = unionBoundsWorld(ids, nodes, definitions)
    if (!u) return
    const pwo = parentId ? parentWorldOrigin(ids[0]!) : { x: 0, y: 0 }
    const gx = u.left - pwo.x
    const gy = u.top - pwo.y
    const gw = u.right - u.left
    const gh = u.bottom - u.top
    const list = [...siblingListForParent(parentId)]
    const insertAt = Math.min(...ids.map((id) => list.indexOf(id)).filter((i) => i >= 0))
    for (const id of ids) removeChildRef(parentId, id)
    const gid = newId()
    const g: SceneGroup = {
      id: gid,
      parentId,
      type: 'group',
      x: gx,
      y: gy,
      width: gw,
      height: gh,
      childIds: [],
    }
    nodes.set(gid, g)
    for (const id of ids) {
      const c = nodes.get(id)
      if (!c) continue
      c.parentId = gid
      c.x -= gx
      c.y -= gy
      g.childIds.push(id)
    }
    insertChildRef(parentId, gid, insertAt)
    selected = new Set([gid])
    commit()
  }

  function ungroupSelection(): void {
    const id = [...selected][0]
    if (!id) return
    const g = nodes.get(id)
    if (g?.type !== 'group') return
    const parentId = g.parentId
    const list = [...siblingListForParent(parentId)]
    const insertIdx = list.indexOf(id)
    removeChildRef(parentId, id)
    const gx = g.x
    const gy = g.y
    const kids = [...g.childIds]
    for (const cid of kids) {
      const c = nodes.get(cid)
      if (!c) continue
      c.parentId = parentId
      c.x += gx
      c.y += gy
    }
    if (parentId === null) {
      const r = roots()
      r.splice(insertIdx, 1)
      r.splice(insertIdx, 0, ...kids)
    } else {
      const p = nodes.get(parentId)
      if (p?.type === 'group') {
        const arr = [...p.childIds]
        const i = arr.indexOf(id)
        if (i >= 0) {
          arr.splice(i, 1, ...kids)
          p.childIds = arr
        }
      }
    }
    nodes.delete(id)
    delete layerNames[id]
    selected = new Set(kids)
    commit()
  }

  function cloneSubtreeAsComponentDefinition(rootId: string): ComponentDefinition | null {
    const ids = [...collectSubtreeIds(nodes, rootId)]
    const idMap = new Map<string, string>()
    for (const oldId of ids) {
      idMap.set(oldId, newId())
    }
    const newNodes: Record<string, DefNode> = {}
    for (const oldId of ids) {
      const raw = nodes.get(oldId)
      if (!raw || raw.type === 'instance') continue
      const nid = idMap.get(oldId)!
      const copy = JSON.parse(JSON.stringify(raw)) as DefNode
      copy.id = nid
      copy.parentId = oldId === rootId ? null : idMap.get(raw.parentId!)!
      if (copy.type === 'group' && raw.type === 'group') {
        copy.childIds = raw.childIds.map((c: string) => idMap.get(c)!)
      }
      newNodes[nid] = copy
    }
    const newRoot = idMap.get(rootId)!
    const def: ComponentDefinition = {
      id: newId(),
      name: `Component ${definitions.size + 1}`,
      rootId: newRoot,
      intrinsicW: 100,
      intrinsicH: 100,
      nodes: newNodes,
    }
    normalizeDefinitionOrigin(def)
    return def
  }

  function createComponentFromSelection(): void {
    const tops = [...selected].filter(
      (id) => ![...selected].some((o) => o !== id && isDescendant(nodes, o, id)),
    )
    if (tops.length === 0) return
    let rootId: string
    if (tops.length === 1) {
      rootId = tops[0]!
    } else {
      const parentId = nodes.get(tops[0]!)?.parentId ?? null
      if (!tops.every((id) => (nodes.get(id)?.parentId ?? null) === parentId)) {
        alert('Select siblings with the same parent, or Group them first.')
        return
      }
      const u = unionBoundsWorld(tops, nodes, definitions)
      if (!u) return
      const pwo = parentId ? parentWorldOrigin(tops[0]!) : { x: 0, y: 0 }
      const gx = u.left - pwo.x
      const gy = u.top - pwo.y
      const gw = u.right - u.left
      const gh = u.bottom - u.top
      const list = [...siblingListForParent(parentId)]
      const insertAt = Math.min(...tops.map((id) => list.indexOf(id)).filter((i) => i >= 0))
      for (const id of tops) removeChildRef(parentId, id)
      const gid = newId()
      const g: SceneGroup = {
        id: gid,
        parentId,
        type: 'group',
        x: gx,
        y: gy,
        width: gw,
        height: gh,
        childIds: [],
      }
      nodes.set(gid, g)
      for (const id of tops) {
        const c = nodes.get(id)
        if (!c) continue
        c.parentId = gid
        c.x -= gx
        c.y -= gy
        g.childIds.push(id)
      }
      insertChildRef(parentId, gid, insertAt)
      rootId = gid
      selected = new Set([gid])
    }
    const n = getNode(rootId)
    if (!n || n.type === 'instance') return
    const wf = worldFrame(nodes, definitions, rootId)
    if (!wf) return
    const def = cloneSubtreeAsComponentDefinition(rootId)
    if (!def) return
    const parentId = n.parentId
    const list = [...siblingListForParent(parentId)]
    const insertIdx = list.indexOf(rootId)
    const pwo = parentId ? parentWorldOrigin(rootId) : { x: 0, y: 0 }
    const ix = wf.x - pwo.x
    const iy = wf.y - pwo.y
    removeChildRef(parentId, rootId)
    for (const x of collectSubtreeIds(nodes, rootId)) {
      nodes.delete(x)
      delete layerNames[x]
    }
    definitions.set(def.id, def)
    const instId = newId()
    nodes.set(instId, {
      id: instId,
      parentId,
      type: 'instance',
      componentId: def.id,
      x: ix,
      y: iy,
      width: wf.width,
      height: wf.height,
    })
    insertChildRef(parentId, instId, insertIdx >= 0 ? insertIdx : roots().length)
    selected = new Set([instId])
    commit()
  }

  function scaleSceneSubtree(nodeId: string, sx: number, sy: number): void {
    const n = nodes.get(nodeId)
    if (!n) return
    n.x *= sx
    n.y *= sy
    n.width *= sx
    n.height *= sy
    if (n.type === 'text') {
      n.fontSize = clamp(Math.round(n.fontSize * Math.min(sx, sy)), 4, 400)
      n.height = n.fontSize
    }
    if (n.type === 'rect') {
      const factor = Math.min(sx, sy)
      n.rx = stripNum(Math.min(n.rx * factor, n.width / 2, n.height / 2))
    }
    if (n.type === 'group') {
      for (const cid of n.childIds) {
        scaleSceneSubtree(cid, sx, sy)
      }
    }
  }

  function detachInstance(): void {
    const id = [...selected][0]
    if (!id) return
    const inst = getNode(id)
    if (inst?.type !== 'instance') return
    const def = definitions.get(inst.componentId)
    if (!def) return
    const parentId = inst.parentId
    const list = [...siblingListForParent(parentId)]
    const insertIdx = list.indexOf(id)
    const sx = inst.width / Math.max(1e-6, def.intrinsicW)
    const sy = inst.height / Math.max(1e-6, def.intrinsicH)
    const idMap = new Map<string, string>()
    for (const k of Object.keys(def.nodes)) {
      idMap.set(k, newId())
    }
    const cloneDefNode = (oldId: string, newParent: string | null): void => {
      const dn = def.nodes[oldId]
      if (!dn) return
      const nid = idMap.get(oldId)!
      const copy = JSON.parse(JSON.stringify(dn)) as SceneNode
      copy.id = nid
      copy.parentId = newParent
      if (copy.type === 'group' && dn.type === 'group') {
        copy.childIds = dn.childIds.map((c: string) => idMap.get(c)!)
      }
      nodes.set(nid, copy)
      if (dn.type === 'group') {
        for (const c of dn.childIds) {
          cloneDefNode(c, nid)
        }
      }
    }
    cloneDefNode(def.rootId, parentId)
    const newRoot = idMap.get(def.rootId)!
    removeChildRef(parentId, id)
    nodes.delete(id)
    const nr = getNode(newRoot)!
    nr.x = inst.x
    nr.y = inst.y
    if (nr.type === 'group') {
      nr.width *= sx
      nr.height *= sy
      for (const cid of nr.childIds) {
        scaleSceneSubtree(cid, sx, sy)
      }
    } else {
      scaleSceneSubtree(newRoot, sx, sy)
    }
    insertChildRef(parentId, newRoot, insertIdx >= 0 ? insertIdx : roots().length)
    selected = new Set([newRoot])
    commit()
  }

  function insertComponentInstance(compId: string): void {
    const def = definitions.get(compId)
    if (!def) return
    const fr = getActiveFrame()
    const w = Math.min(def.intrinsicW, fr.width * 0.5)
    const h = Math.min(def.intrinsicH, fr.height * 0.5)
    const nid = newId()
    nodes.set(nid, {
      id: nid,
      parentId: null,
      type: 'instance',
      componentId: compId,
      x: fr.x + (fr.width - w) / 2,
      y: fr.y + (fr.height - h) / 2,
      width: w,
      height: h,
    })
    roots().push(nid)
    selected = new Set([nid])
    commit()
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
    recomputeIntrinsic(def)
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

  function worldNodeOrigin(id: string): { x: number; y: number } {
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
    return { x: ox, y: oy }
  }

  function serializeSubtreeForExport(id: string, ind: string): string {
    const n = nodes.get(id)
    if (!n) return ''
    if (n.type === 'group') {
      const inner = n.childIds
        .map((cid) => serializeSceneSubtreeSvg(nodes, definitions, cid, `${ind}  `))
        .join('\n')
      return `${ind}<g>\n${inner}\n${ind}</g>`
    }
    if (n.type === 'instance') {
      const def = definitions.get(n.componentId)
      if (!def) return ''
      const sx = n.width / Math.max(1e-6, def.intrinsicW)
      const sy = n.height / Math.max(1e-6, def.intrinsicH)
      const inner = serializeDefSubtreeSvg(def, def.rootId, `${ind}  `)
      return `${ind}<g transform="scale(${sx} ${sy})">\n${inner}\n${ind}</g>`
    }
    return `${ind}${buildSvgFragmentLeafLocal(n)}`
  }

  function hitTestWorld(wx: number, wy: number): string | null {
    for (let fi = frames.length - 1; fi >= 0; fi--) {
      const fr = frames[fi]!.rootIds
      for (let ri = fr.length - 1; ri >= 0; ri--) {
        const h = hitNode(wx, wy, fr[ri]!, nodes)
        if (h) return h
      }
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

  function enterComponentEdit(compId: string): void {
    const d = definitions.get(compId)
    if (!d) return
    closeColorPickerPanel()
    mainNodesBackup = new Map(nodes)
    mainRootIdsBackup = [...roots()]
    nodes = recordToNodes({ ...d.nodes } as Record<string, unknown>)
    componentEditRoots = [d.rootId]
    editingComponentId = compId
    selected.clear()
    btnCompDone.hidden = false
    commit()
  }

  function exitComponentEdit(save: boolean): void {
    if (!editingComponentId || !mainNodesBackup || !mainRootIdsBackup) {
      editingComponentId = null
      mainNodesBackup = null
      mainRootIdsBackup = null
      btnCompDone.hidden = true
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
    const af = getActiveFrame()
    af.rootIds.splice(0, af.rootIds.length, ...(mainRootIdsBackup ?? []))
    mainRootIdsBackup = null
    componentEditRoots = null
    mainNodesBackup = null
    editingComponentId = null
    btnCompDone.hidden = true
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
    btnBringFront.disabled = selected.size === 0
    btnSendBack.disabled = selected.size === 0
    updateHierarchyButtons()
    layerList.querySelectorAll<HTMLLIElement>('.pop-layer').forEach((li) => {
      const id = li.dataset.id
      if (!id) return
      li.classList.toggle('pop-layer-selected', selected.has(id))
    })
    itemsG.querySelectorAll<SVGGElement>('.pop-item').forEach((g) => {
      const id = g.dataset.id
      if (!id) return
      const canvasHighlight =
        selected.size > 0 &&
        [...selected].some((s) => isDescendant(nodes, s, id))
      g.classList.toggle('pop-item-selected', canvasHighlight)
    })
    if (layersAsideTab === 'parent') renderParentPanel()
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
    if (parentId === null) return roots()
    const p = nodes.get(parentId)
    return p?.type === 'group' ? p.childIds : []
  }

  /** Mutable sibling order for paint order (first = back, last = front). */
  function getMutableSiblingList(nodeId: string): string[] | null {
    const n = nodes.get(nodeId)
    if (!n) return null
    if (n.parentId !== null) {
      const p = nodes.get(n.parentId)
      return p?.type === 'group' ? p.childIds : null
    }
    if (componentEditRoots !== null) {
      return componentEditRoots.includes(nodeId) ? componentEditRoots : null
    }
    for (const f of frames) {
      if (f.rootIds.includes(nodeId)) return f.rootIds
    }
    return null
  }

  /** Groups roots that share the same sibling list (frame roots, component roots, or group children). */
  function siblingGroupKey(id: string): string | null {
    const n = nodes.get(id)
    if (!n) return null
    if (n.parentId !== null) return `g:${n.parentId}`
    if (componentEditRoots !== null) {
      return componentEditRoots.includes(id) ? 'comp' : null
    }
    for (const f of frames) {
      if (f.rootIds.includes(id)) return `f:${f.id}`
    }
    return null
  }

  function reorderSelectedInStack(mode: 'front' | 'back'): void {
    const tops = selectedDeletionRoots()
    if (tops.length === 0) return
    const byKey = new Map<string, string[]>()
    for (const id of tops) {
      const k = siblingGroupKey(id)
      if (!k) continue
      const arr = byKey.get(k) ?? []
      arr.push(id)
      byKey.set(k, arr)
    }
    if (byKey.size === 0) return
    for (const ids of byKey.values()) {
      const sample = ids[0]!
      const list = getMutableSiblingList(sample)
      if (!list) continue
      const idSet = new Set(ids)
      const sorted = [...ids].sort((a, b) => list.indexOf(a) - list.indexOf(b))
      const rest = list.filter((x) => !idSet.has(x))
      if (mode === 'front') {
        list.splice(0, list.length, ...rest, ...sorted)
      } else {
        list.splice(0, list.length, ...sorted, ...rest)
      }
    }
    commit()
  }

  function bringSelectionToFront(): void {
    reorderSelectedInStack('front')
  }

  function sendSelectionToBack(): void {
    reorderSelectedInStack('back')
  }

  /** Wrap a single leaf in a new group at the same place in the tree (for nest-into). */
  function wrapLeafAsNewGroup(leafId: string): string | null {
    const t = nodes.get(leafId)
    if (!t || t.type === 'instance' || t.type === 'group') return null
    const parentId = t.parentId
    const list = [...siblingListForParent(parentId)]
    const idx = list.indexOf(leafId)
    if (idx < 0) return null
    removeChildRef(parentId, leafId)
    const gid = newId()
    const g: SceneGroup = {
      id: gid,
      parentId,
      type: 'group',
      x: t.x,
      y: t.y,
      width: t.width,
      height: t.height,
      childIds: [leafId],
    }
    nodes.set(gid, g)
    t.parentId = gid
    t.x = 0
    t.y = 0
    insertChildRef(parentId, gid, idx)
    return gid
  }

  /**
   * Target for "drop into": existing group, or parent group if target is the only child (avoid nested wrappers),
   * or a new wrapper group around a leaf.
   */
  function resolveNestContainerId(targetId: string): string | null {
    const t = nodes.get(targetId)
    if (!t || t.type === 'instance') return null
    if (t.type === 'group') return targetId
    const p = t.parentId
    const pn = p ? nodes.get(p) : undefined
    if (pn?.type === 'group' && pn.childIds.length === 1 && pn.childIds[0] === targetId) {
      return p!
    }
    return wrapLeafAsNewGroup(targetId)
  }

  function moveLayerNode(
    dragId: string,
    targetId: string,
    kind: 'before' | 'into',
  ): void {
    if (dragId === targetId) return
    const d = nodes.get(dragId)
    if (!d) return

    if (kind === 'into') {
      if (isDescendant(nodes, dragId, targetId)) return
      const containerId = resolveNestContainerId(targetId)
      if (!containerId) return
      if (isDescendant(nodes, dragId, containerId)) return
      const g = nodes.get(containerId)
      if (g?.type !== 'group') return
      const wf = worldFrame(nodes, definitions, dragId)
      if (!wf) return
      const insertAt = g.childIds.length
      insertChildRef(containerId, dragId, insertAt)
      const pwf = worldFrame(nodes, definitions, containerId)
      if (!pwf) return
      d.x = wf.x - pwf.x
      d.y = wf.y - pwf.y
      return
    }

    if (isDescendant(nodes, dragId, targetId)) return
    const t = nodes.get(targetId)
    if (!t) return
    const parentId = t.parentId
    const listBefore = [...siblingListForParent(parentId)]
    const ti = listBefore.indexOf(targetId)
    if (ti < 0) return
    const wf = worldFrame(nodes, definitions, dragId)
    if (!wf) return
    removeChildRef(d.parentId, dragId)
    const listAfter = siblingListForParent(parentId)
    const insertAt = listAfter.indexOf(targetId)
    if (insertAt < 0) return
    insertChildRef(parentId, dragId, insertAt)
    if (parentId === null) {
      d.x = wf.x
      d.y = wf.y
    } else {
      const pwf = worldFrame(nodes, definitions, parentId)
      if (!pwf) return
      d.x = wf.x - pwf.x
      d.y = wf.y - pwf.y
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
      dragEl.draggable = false
      dragEl.setAttribute('aria-hidden', 'true')
      dragEl.textContent = '⠿'

      row.draggable = true
      row.addEventListener('dragstart', (e) => {
        if ((e.target as HTMLElement).closest('.pop-layer-name')) {
          e.preventDefault()
          return
        }
        layerDragId = id
        e.dataTransfer?.setData('text/plain', id)
        e.dataTransfer!.effectAllowed = 'move'
        li.classList.add('pop-layer-dragging')
      })
      row.addEventListener('dragend', () => {
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
        syncStyleFromSelection()
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
        const intoZone =
          item.type === 'instance'
            ? false
            : item.type === 'group'
              ? e.clientY > rect.top + rect.height * 0.33
              : e.clientY > rect.top + rect.height * 0.5
        layerList.querySelectorAll('.pop-layer-drop-before, .pop-layer-drop-into').forEach((el) => {
          el.classList.remove('pop-layer-drop-before', 'pop-layer-drop-into')
        })
        if (intoZone) {
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
        if (additiveMultiSelect(e)) {
          if (selected.has(id)) selected.delete(id)
          else selected.add(id)
        } else {
          selected = new Set([id])
        }
        updateSelectionUi()
        syncPropsFromSelection()
        syncStyleFromSelection()
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

    if (preserveId) {
      const esc =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(preserveId)
          : preserveId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const inp = layerList.querySelector<HTMLInputElement>(
        `li.pop-layer[data-id="${esc}"] .pop-layer-name`,
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

  function renderDefSubtree(
    def: ComponentDefinition,
    id: string,
    parentG: SVGGElement,
  ): void {
    const n = def.nodes[id]
    if (!n) return
    if (n.type === 'group') {
      const gg = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      gg.setAttribute('transform', `translate(${n.x} ${n.y})`)
      for (const cid of n.childIds) {
        renderDefSubtree(def, cid, gg)
      }
      parentG.appendChild(gg)
      return
    }
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.setAttribute('transform', `translate(${n.x} ${n.y})`)
    const frag = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    frag.innerHTML = buildSvgFragmentLeafLocal(n)
    while (frag.firstChild) g.appendChild(frag.firstChild)
    parentG.appendChild(g)
  }

  function renderSceneNode(id: string, parentG: SVGGElement): void {
    const item = nodes.get(id)
    if (!item) return
    if (item.type === 'group') {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.classList.add('pop-item')
      g.dataset.id = item.id
      g.setAttribute('transform', `translate(${item.x} ${item.y})`)
      for (const cid of item.childIds) {
        renderSceneNode(cid, g)
      }
      parentG.appendChild(g)
      return
    }
    if (item.type === 'instance') {
      const def = definitions.get(item.componentId)
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.classList.add('pop-item')
      g.dataset.id = item.id
      const sx = item.width / Math.max(1e-6, def?.intrinsicW ?? 1)
      const sy = item.height / Math.max(1e-6, def?.intrinsicH ?? 1)
      g.setAttribute('transform', `translate(${item.x} ${item.y}) scale(${sx} ${sy})`)
      if (def) {
        renderDefSubtree(def, def.rootId, g)
      }
      parentG.appendChild(g)
      return
    }
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    g.classList.add('pop-item')
    g.dataset.id = item.id
    g.setAttribute('transform', `translate(${item.x} ${item.y})`)
    const frag = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    frag.innerHTML = buildSvgFragmentLeafLocal(item)
    while (frag.firstChild) g.appendChild(frag.firstChild)
    parentG.appendChild(g)
  }

  function renderItems(): void {
    itemsG.replaceChildren()
    for (const frame of frames) {
      for (const rid of frame.rootIds) {
        renderSceneNode(rid, itemsG)
      }
    }
    updateSelectionUi()
  }

  const HANDLE_HALF = 5

  function parentWorldOrigin(nodeId: string): { x: number; y: number } {
    const n = nodes.get(nodeId)
    if (!n) return { x: 0, y: 0 }
    let ox = 0
    let oy = 0
    let cur: string | null = n.parentId
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
    return { x: ox, y: oy }
  }

  /** World-space position of the origin of `parentId`'s local coordinate system (direct children use this offset). */
  function worldSpaceOriginForParent(parentId: string | null): { x: number; y: number } {
    if (parentId === null) return { x: 0, y: 0 }
    let ox = 0
    let oy = 0
    let cur: string | null = parentId
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
    return { x: ox, y: oy }
  }

  function pointerToLocalParent(px: number, py: number, nodeId: string): { x: number; y: number } {
    const o = parentWorldOrigin(nodeId)
    return { x: px - o.x, y: py - o.y }
  }

  function renderHandles(): void {
    handlesG.replaceChildren()
    if (tool !== 'select' || selected.size !== 1) return
    const id = [...selected][0]!
    const it = getNode(id)
    if (!it) return

    const wf = worldFrame(nodes, definitions, id)
    if (!wf) return

    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    outline.setAttribute('x', String(wf.x))
    outline.setAttribute('y', String(wf.y))
    outline.setAttribute('width', String(wf.width))
    outline.setAttribute('height', String(wf.height))
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
      hr.setAttribute('fill', '#100c18')
      hr.setAttribute('stroke', '#a78bfa')
      hr.setAttribute('stroke-width', '1')
      hr.setAttribute('data-pop-handle', hid)
      hr.setAttribute('data-item-id', id)
      hr.setAttribute('vector-effect', 'non-scaling-stroke')
      hr.style.cursor = HANDLE_CURSORS[hid]
      handlesG.appendChild(hr)
    }

    const { x, y, width: w, height: h } = wf
    addHandle('nw', x, y)
    addHandle('n', x + w / 2, y)
    addHandle('ne', x + w, y)
    addHandle('e', x + w, y + h / 2)
    addHandle('se', x + w, y + h)
    addHandle('s', x + w / 2, y + h)
    addHandle('sw', x, y + h)
    addHandle('w', x, y + h / 2)
  }

  function syncTypographyPanel(): void {
    const n = selected.size
    const one = n === 1 ? getNode([...selected][0]!) : undefined
    const isText = one?.type === 'text'
    typographyProps.hidden = !isText
    if (!isText || !one || one.type !== 'text') return
    inpFontFamily.value = one.fontFamily
    inpFontWeight.value = String(one.fontWeight)
    inpLetterSpacing.value = String(one.letterSpacing)
    inpLineHeight.value = String(one.lineHeight)
  }

  function syncGroupLayoutPanel(): void {
    const n = selected.size
    const one = n === 1 ? getNode([...selected][0]!) : undefined
    const isGroup = one?.type === 'group'
    groupLayoutProps.hidden = !isGroup
    if (!isGroup || !one || one.type !== 'group') return
    const layout = one.layout
    if (!layout || layout.type === 'none') {
      selGroupLayout.value = 'none'
      inpGroupGap.value = '8'
      inpGroupPad.value = '8'
    } else if (layout.type === 'stack') {
      selGroupLayout.value = layout.direction === 'horizontal' ? 'stack-h' : 'stack-v'
      inpGroupGap.value = String(layout.gap)
      inpGroupPad.value = String(layout.padding)
    }
  }

  function updateCanvasDimensions(): void {
    recomputeWorldSize()
    svg.setAttribute('viewBox', `0 0 ${worldW} ${worldH}`)
    svg.setAttribute('width', String(worldW))
    svg.setAttribute('height', String(worldH))
    canvasBgEl.setAttribute('width', String(worldW))
    canvasBgEl.setAttribute('height', String(worldH))
    syncWorkspaceChrome()
  }

  function renderFrameOutlines(): void {
    frameOutlinesG.replaceChildren()
    const inactiveStroke = 'rgba(124,156,255,0.35)'
    const activeStroke = '#7c9cff'
    for (const f of frames) {
      // One full-canvas frame reads as a permanent “selection” over the grid; skip chrome
      // so zoom/pan feels like a free workspace (outlines return for multi-frame or inset frames).
      if (
        frames.length === 1 &&
        f.x === 0 &&
        f.y === 0 &&
        f.width >= worldW &&
        f.height >= worldH
      ) {
        continue
      }
      const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      r.setAttribute('x', String(f.x))
      r.setAttribute('y', String(f.y))
      r.setAttribute('width', String(f.width))
      r.setAttribute('height', String(f.height))
      r.setAttribute('fill', 'none')
      const isActive = f.id === activeFrameId
      r.setAttribute(
        'stroke',
        frames.length > 1 && isActive ? activeStroke : inactiveStroke,
      )
      r.setAttribute('stroke-width', '1')
      r.setAttribute('stroke-dasharray', '6 4')
      r.setAttribute('vector-effect', 'non-scaling-stroke')
      frameOutlinesG.appendChild(r)
    }
  }

  function syncFramePicker(): void {
    const cur = popFramePick.value
    popFramePick.replaceChildren()
    for (const f of frames) {
      const o = document.createElement('option')
      o.value = f.id
      o.textContent = f.label
      popFramePick.appendChild(o)
    }
    if (frames.some((f) => f.id === cur)) popFramePick.value = cur
    else popFramePick.value = activeFrameId
  }

  function commit(): void {
    pruneLayerNames()
    updateCanvasDimensions()
    renderFrameOutlines()
    syncFramePicker()
    renderItems()
    renderHandles()
    renderLayers()
    renderStaticGuides()
    if (!propsPanelFocused) syncPropsFromSelection()
    if (!stylePanelFocused) syncStyleFromSelection()
    syncTypographyPanel()
    syncGroupLayoutPanel()
    schedulePersist()
  }

  function clientToSvg(ev: PointerEvent): { x: number; y: number } {
    return clientToSvgCoords(ev.clientX, ev.clientY)
  }

  function hitItemId(ev: PointerEvent): string | null {
    const { x, y } = clientToSvg(ev)
    return hitTestWorld(x, y)
  }

  toolButtons.forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool as Tool))
  })

  layerList.addEventListener('dragover', (e) => {
    if (!layerDragId) return
    e.preventDefault()
  })

  btnGroup.addEventListener('click', () => groupSelection())
  btnUngroup.addEventListener('click', () => ungroupSelection())
  btnBringFront.addEventListener('click', () => bringSelectionToFront())
  btnSendBack.addEventListener('click', () => sendSelectionToBack())
  btnCreateComp.addEventListener('click', () => createComponentFromSelection())
  btnDetach.addEventListener('click', () => detachInstance())
  btnEditComp.addEventListener('click', () => {
    const id = [...selected][0]
    const n = id ? getNode(id) : undefined
    if (n?.type === 'instance') enterComponentEdit(n.componentId)
  })
  btnCompDone.addEventListener('click', () => exitComponentEdit(true))
  selCompPick.addEventListener('change', () => {
    btnInsertInst.disabled = definitions.size === 0 || selCompPick.value === ''
  })
  btnInsertInst.addEventListener('click', () => {
    const v = selCompPick.value
    if (v) insertComponentInstance(v)
  })

  syncViewportTransform()
  updateZoomPctLabel()

  const gridSyncRo = new ResizeObserver(() => syncWorkspaceChrome())
  gridSyncRo.observe(canvasWrap)
  canvasWrap.addEventListener('scroll', () => syncWorkspaceChrome(), { passive: true })
  requestAnimationFrame(() => {
    syncWorkspaceChrome()
    requestAnimationFrame(() => syncWorkspaceChrome())
  })

  function bindZoomControls(
    btnIn: HTMLButtonElement,
    btnOut: HTMLButtonElement,
    btnReset: HTMLButtonElement,
  ): void {
    btnIn.addEventListener('click', () => {
      zoomAtWorldPoint(worldW / 2, worldH / 2, viewScale * 1.2)
    })
    btnOut.addEventListener('click', () => {
      zoomAtWorldPoint(worldW / 2, worldH / 2, viewScale / 1.2)
    })
    btnReset.addEventListener('click', () => {
      viewTx = 0
      viewTy = 0
      viewScale = 1
      syncViewportTransform()
      updateZoomPctLabel()
      schedulePersist()
    })
  }
  bindZoomControls(btnZoomIn, btnZoomOut, btnZoomReset)
  bindZoomControls(btnZoomInDock, btnZoomOutDock, btnZoomResetDock)

  btnZoomFit.addEventListener('click', () => {
    zoomToFitCanvas()
  })
  btnZoomFitDock.addEventListener('click', () => {
    zoomToFitCanvas()
  })

  canvasWrap.addEventListener(
    'wheel',
    (ev) => {
      if (!canvasWrap.contains(ev.target as Node)) return
      // ⌘+scroll: pan. Ctrl+scroll / pinch (ctrl) keeps zoom; avoids ⌘ also setting ctrl on some setups.
      if (ev.metaKey && !ev.ctrlKey) {
        ev.preventDefault()
        viewTx -= ev.deltaX
        viewTy -= ev.deltaY
        syncViewportTransform()
        schedulePersist()
        return
      }
      if (!ev.ctrlKey) return
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
      const it = getNode(id)
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
      const it = getNode(id)
      if (it && (it.type === 'rect' || it.type === 'ellipse')) {
        it.stroke = defaultStroke
      }
    }
    commit()
  })

  strokeWInput.addEventListener('input', () => {
    syncChromeFromInputs()
    for (const id of selected) {
      const it = getNode(id)
      if (it && (it.type === 'rect' || it.type === 'ellipse')) {
        it.strokeWidth = defaultStrokeWidth
      }
    }
    commit()
  })

  opacityInput.addEventListener('input', () => {
    syncChromeFromInputs()
    const o = defaultOpacity
    for (const id of selected) {
      const it = getNode(id)
      if (it && (it.type === 'rect' || it.type === 'ellipse' || it.type === 'text' || it.type === 'image')) {
        it.opacity = o
      }
    }
    commit()
  })

  rxInput.addEventListener('input', () => {
    syncChromeFromInputs()
    const want = defaultRx
    for (const id of selected) {
      const it = getNode(id)
      if (it?.type === 'rect') {
        it.rx = want
        clampRectCornerRadius(it)
      }
    }
    commit()
  })

  btnDelete.addEventListener('click', () => {
    deleteNodesSubtrees(selectedDeletionRoots())
    selected.clear()
    commit()
  })

  btnExportSel.addEventListener('click', () => {
    if (selected.size === 0) {
      alert(
        'Select one or more layers first (canvas or list; ⌘/Ctrl+click or Shift+click for multi-select).',
      )
      return
    }
    const tops = [...selected].filter(
      (id) => ![...selected].some((o) => o !== id && isDescendant(nodes, o, id)),
    )
    const parts = tops
      .map((id) => {
        const o = worldNodeOrigin(id)
        const inner = serializeSubtreeForExport(id, '    ')
        return `  <g transform="translate(${o.x} ${o.y})">\n${inner}\n  </g>`
      })
      .join('\n')
    const f = getActiveFrame()
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f.width}" height="${f.height}" viewBox="0 0 ${f.width} ${f.height}">
${parts}
</svg>
`
    downloadSvg(svg, 'pop-selection.svg')
  })

  btnExportAll.addEventListener('click', () => {
    const f = getActiveFrame()
    downloadSvg(
      serializeSvgFromRoots(roots(), nodes, definitions, f.width, f.height),
      `pop-frame-${f.label.replace(/\s+/g, '-')}.svg`,
    )
  })

  tabLayersBtn.addEventListener('click', () => setLayersAsideTab('layers'))
  tabParentBtn.addEventListener('click', () => setLayersAsideTab('parent'))
  btnSelectSiblings.addEventListener('click', () => {
    const prim = primarySelectionId()
    if (!prim) return
    const p = nodes.get(prim)?.parentId ?? null
    selected = new Set(siblingListForParent(p))
    updateSelectionUi()
    syncPropsFromSelection()
    syncStyleFromSelection()
    renderHandles()
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
        const fr = getActiveFrame()
        const x = fr.x + (fr.width - w) / 2
        const y = fr.y + (fr.height - h) / 2
        const nid = newId()
        nodes.set(nid, {
          id: nid,
          parentId: null,
          type: 'image',
          x,
          y,
          width: w,
          height: h,
          href,
          opacity: defaultOpacity,
        })
        roots().push(nid)
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
        const it = getNode(iid)
        if (it && it.type !== 'group') {
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
        if (additiveMultiSelect(ev)) {
          if (selected.has(id)) selected.delete(id)
          else selected.add(id)
        } else if (!selected.has(id)) {
          selected = new Set([id])
        }
        updateSelectionUi()
        syncPropsFromSelection()
        syncStyleFromSelection()
        renderHandles()
        dragState.active = true
        dragState.pointerId = ev.pointerId
        const p0 = clientToSvg(ev)
        dragState.startSvgX = p0.x
        dragState.startSvgY = p0.y
        dragState.origins.clear()
        for (const sid of selected) {
          const it = getNode(sid)
          if (it) dragState.origins.set(sid, { x: it.x, y: it.y })
        }
        svg.setPointerCapture(ev.pointerId)
      } else {
        if (!additiveMultiSelect(ev)) selected.clear()
        updateSelectionUi()
        syncPropsFromSelection()
        syncStyleFromSelection()
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
      nodes.set(nid, {
        id: nid,
        parentId: null,
        type: 'rect',
        x: x - w / 2,
        y: y - h / 2,
        width: w,
        height: h,
        fill: defaultFill,
        stroke: defaultStroke,
        strokeWidth: defaultStrokeWidth,
        rx: defaultRx,
        opacity: defaultOpacity,
      })
      clampRectCornerRadius(nodes.get(nid)!)
      roots().push(nid)
      selected = new Set([nid])
      setTool('select')
    } else if (tool === 'ellipse') {
      const w = 120
      const h = 120
      const nid = newId()
      nodes.set(nid, {
        id: nid,
        parentId: null,
        type: 'ellipse',
        x: x - w / 2,
        y: y - h / 2,
        width: w,
        height: h,
        fill: defaultFill,
        stroke: defaultStroke,
        strokeWidth: defaultStrokeWidth,
        opacity: defaultOpacity,
      })
      roots().push(nid)
      selected = new Set([nid])
      setTool('select')
    } else if (tool === 'text') {
      const content = window.prompt('Text to place', 'Hello')
      if (content === null) return
      const fontSize = 28
      const nid = newId()
      nodes.set(nid, {
        id: nid,
        parentId: null,
        type: 'text',
        x,
        y: y - fontSize,
        width: 200,
        height: fontSize,
        content,
        fontSize,
        fill: defaultFill,
        opacity: defaultOpacity,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 400,
        letterSpacing: 0,
        lineHeight: 1.2,
      })
      roots().push(nid)
      selected = new Set([nid])
      setTool('select')
    }

    commit()
  })

  window.addEventListener('pointermove', (ev) => {
    if (resizeState.active && ev.pointerId === resizeState.pointerId) {
      const it = resizeState.itemId ? getNode(resizeState.itemId) : undefined
      const hid = resizeState.handle
      if (!it || !hid || it.type === 'group') return
      const p = clientToSvg(ev)
      const pl = pointerToLocalParent(p.x, p.y, resizeState.itemId!)
      const out = applyResizeHandle(hid, pl.x, pl.y, resizeState.start)
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
      if (it.type === 'rect') clampRectCornerRadius(it)
      renderItems()
      renderHandles()
      if (!propsPanelFocused) syncPropsFromSelection()
      if (!stylePanelFocused) syncStyleFromSelection()
      return
    }

    if (!dragState.active || ev.pointerId !== dragState.pointerId) return
    const p = clientToSvg(ev)
    const dx = p.x - dragState.startSvgX
    const dy = p.y - dragState.startSvgY
    for (const sid of selected) {
      const origin = dragState.origins.get(sid)
      const it = getNode(sid)
      if (!origin || !it) continue
      it.x = origin.x + dx
      it.y = origin.y + dy
    }

    let vGuide: number | null = null
    let hGuide: number | null = null
    lastSnapHint = null

    if (symmetryGuidesOn && selected.size > 0) {
      const u = unionBoundsWorld(selected, nodes, definitions)
      if (u) {
        const sb = snapBoundsForFrame()
        const tx = collectSnapTargetsX(selected, nodes, definitions, sb)
        const ty = collectSnapTargetsY(selected, nodes, definitions, sb)
        const sx = snapAxis('x', u.left, u.cx, u.right, tx, SNAP_PX, sb)
        const sy = snapAxis('y', u.top, u.cy, u.bottom, ty, SNAP_PX, sb)
        if (sx.delta !== 0 || sy.delta !== 0) {
          for (const sid of selected) {
            const it = getNode(sid)
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
      if (!stylePanelFocused) syncStyleFromSelection()
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
    if (!stylePanelFocused) syncStyleFromSelection()
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
      if (!stylePanelFocused) syncStyleFromSelection()
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
      if (!stylePanelFocused) syncStyleFromSelection()
      schedulePersist()
    }
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && editingComponentId) {
      exitComponentEdit(false)
      return
    }
    const tEl = ev.target as HTMLElement | null
    const inFormField =
      Boolean(tEl?.closest?.('input, textarea, select, [contenteditable="true"]')) ||
      Boolean(tEl?.isContentEditable)
    if (inFormField) {
      if (ev.key === 'Delete' || ev.key === 'Backspace') return
      if (ev.metaKey || ev.ctrlKey) {
        const k = ev.key.toLowerCase()
        if (k === 'c' || k === 'v') return
      }
    }
    const mod = ev.metaKey || ev.ctrlKey
    if (mod) {
      const k = ev.key.toLowerCase()
      if (k === 'c') {
        if (selected.size === 0) return
        ev.preventDefault()
        void copySelectionToSystemClipboard()
        return
      }
      if (k === 'v') {
        ev.preventDefault()
        void pasteFromSystemClipboard()
        return
      }
      if (ev.shiftKey && selected.size > 0) {
        if (ev.code === 'BracketRight') {
          ev.preventDefault()
          bringSelectionToFront()
          return
        }
        if (ev.code === 'BracketLeft') {
          ev.preventDefault()
          sendSelectionToBack()
          return
        }
      }
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (selected.size === 0) return
      ev.preventDefault()
      deleteNodesSubtrees(selectedDeletionRoots())
      selected.clear()
      commit()
    }
  })

  popFramePick.addEventListener('change', () => {
    const v = popFramePick.value
    if (frames.some((x) => x.id === v)) {
      activeFrameId = v
      commit()
    }
  })

  btnFrameAdd.addEventListener('click', () => {
    const b = computeWorldBoundsWithContent(frames, nodes, definitions, VIEW_W, VIEW_H)
    const nf = createDefaultFrame()
    nf.x = b.worldW + 32
    nf.y = 0
    nf.width = 390
    nf.height = 844
    nf.label = `Frame ${frames.length + 1}`
    frames.push(nf)
    activeFrameId = nf.id
    commit()
  })

  btnDocOpen.addEventListener('click', () => {
    docFileInput.click()
  })

  docFileInput.addEventListener('change', () => {
    const file = docFileInput.files?.[0]
    docFileInput.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as unknown
        const doc = loadDocumentV3(parsed)
        if (!doc) {
          alert('Invalid Pop document JSON.')
          return
        }
        applyDocumentV3(doc)
        selected.clear()
        commit()
      } catch {
        alert('Could not read document file.')
      }
    }
    reader.readAsText(file)
  })

  btnDocSave.addEventListener('click', () => {
    const json = documentToV3Json(buildDocumentV3())
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(docName || 'pop').replace(/[^\w.-]+/g, '-')}.pop.json`
    a.rel = 'noopener'
    a.click()
    URL.revokeObjectURL(url)
  })

  btnExportHtml.addEventListener('click', () => {
    const f = getActiveFrame()
    const html = exportFrameToHtml(f, nodes, definitions, tokens, { title: docName })
    downloadHtml(html, `${(f.label || 'frame').replace(/\s+/g, '-')}.html`)
  })

  btnExportHtmlAll.addEventListener('click', () => {
    let delay = 0
    for (const f of frames) {
      const html = exportFrameToHtml(f, nodes, definitions, tokens, { title: `${docName} · ${f.label}` })
      const name = `${(f.label || 'frame').replace(/\s+/g, '-')}.html`
      window.setTimeout(() => downloadHtml(html, name), delay)
      delay += 200
    }
  })

  function applyTypographyFromInputs(): void {
    const ff = inpFontFamily.value.trim() || 'system-ui, sans-serif'
    const fw = clamp(Math.round(Number(inpFontWeight.value) || 400), 100, 900)
    const ls = Number.isFinite(Number(inpLetterSpacing.value)) ? Number(inpLetterSpacing.value) : 0
    const lh =
      Number.isFinite(Number(inpLineHeight.value)) && Number(inpLineHeight.value) > 0
        ? Number(inpLineHeight.value)
        : 1.2
    for (const id of selected) {
      const it = getNode(id)
      if (it?.type !== 'text') continue
      it.fontFamily = ff
      it.fontWeight = fw
      it.letterSpacing = ls
      it.lineHeight = lh
    }
    commit()
  }

  ;[inpFontFamily, inpFontWeight, inpLetterSpacing, inpLineHeight].forEach((el) => {
    el.addEventListener('change', () => applyTypographyFromInputs())
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyTypographyFromInputs()
    })
  })

  function applyGroupLayoutFromInputs(): void {
    const id = [...selected][0]
    const g = id ? getNode(id) : undefined
    if (!g || g.type !== 'group') return
    const mode = selGroupLayout.value
    let layout: GroupLayout
    if (mode === 'none') layout = { type: 'none' }
    else {
      const gap = Math.max(0, Math.round(Number(inpGroupGap.value) || 0))
      const padding = Math.max(0, Math.round(Number(inpGroupPad.value) || 0))
      layout = {
        type: 'stack',
        direction: mode === 'stack-h' ? 'horizontal' : 'vertical',
        gap,
        padding,
      }
    }
    g.layout = layout
    commit()
  }

  selGroupLayout.addEventListener('change', () => applyGroupLayoutFromInputs())
  inpGroupGap.addEventListener('change', () => applyGroupLayoutFromInputs())
  inpGroupPad.addEventListener('change', () => applyGroupLayoutFromInputs())

  setBaseSymHint()
  commit()
}
