import { buildExcelThemeGrid, EXCEL_STANDARD_COLORS, normalizeHex6 } from './studio/color-palette.ts'
import {
  MAX_VIEW_SCALE,
  MIN_ITEM_SIZE,
  MIN_VIEW_SCALE,
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
  defsToRecord,
  isValidCanvasItem,
  migrateV1ToScene,
  nodesToRecord,
  recordToDefs,
  recordToNodes,
  STORAGE_KEY_V1,
  STORAGE_KEY_V2,
} from './studio/persistence.ts'

const TOOLBAR_PIN_STORAGE_KEY = 'pop-toolbar-pinned'
import type { PersistedStateV1, PersistedStateV2 } from './studio/persistence.ts'
import type { ComponentDefinition, DefNode, SceneGroup, SceneNode, Tool } from './studio/scene-types.ts'
import { collectSnapTargetsX, collectSnapTargetsY, snapAxis } from './studio/snap.ts'
import {
  buildSvgFragmentLeafLocal,
  downloadSvg,
  itemLabel,
  serializeDefSubtreeSvg,
  serializeSceneSubtreeSvg,
  serializeSvgFromRoots,
} from './studio/svg-export.ts'

export function mount(root: HTMLElement): void {
  let rootIds: string[] = []
  let nodes = new Map<string, SceneNode>()
  let definitions = new Map<string, ComponentDefinition>()
  /** When set, canvas shows definition tree for editing the main component. */
  let editingComponentId: string | null = null
  let mainNodesBackup: Map<string, SceneNode> | null = null
  let mainRootIdsBackup: string[] | null = null
  /** Custom layer names by item id; when missing, UI falls back to `itemLabel`. */
  let layerNames: Record<string, string> = {}
  let selected = new Set<string>()
  /** Left sidebar: layer tree vs parent-chain helper (Figma-style hierarchy). */
  let layersAsideTab: 'layers' | 'parent' = 'layers'
  let tool: Tool = 'select'
  let defaultFill = '#3b82f6'
  let defaultStroke = '#1e3a5f'
  let defaultStrokeWidth = 2
  let symmetryGuidesOn = true
  let propsPanelFocused = false
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
      <header class="pop-header">
        <h1 class="pop-title">Pop</h1>
        <p class="pop-sub">Draw on the canvas, add images, then export SVG. Raster images become <code>&lt;image&gt;</code> in the SVG (embedded), not auto-traced vectors.</p>
      </header>
      <div class="pop-toolbar-wrap" id="pop-toolbar-wrap">
        <div class="pop-toolbar-bar">
          <button type="button" class="pop-btn pop-toolbar-pin" id="pop-toolbar-pin" aria-pressed="false" aria-expanded="false" aria-controls="pop-toolbar-expanded">
            <span class="pop-toolbar-pin-glyph" aria-hidden="true">📌</span>
            <span class="pop-toolbar-pin-label">Pin toolbar</span>
          </button>
          <div class="pop-toolbar-expanded" id="pop-toolbar-expanded" role="toolbar" aria-label="Studio tools" hidden>
            <div class="pop-tb-dd" data-pop-tb-dd>
              <button type="button" class="pop-btn pop-tb-dd-trigger" id="pop-tb-tools-btn" aria-expanded="false" aria-haspopup="true" aria-controls="pop-tb-tools-panel">Tools</button>
              <div class="pop-tb-dd-panel" id="pop-tb-tools-panel" role="region" aria-labelledby="pop-tb-tools-btn" hidden>
                <p class="pop-tb-dd-desc" id="pop-tb-tools-desc">Pick what you draw on the canvas next.</p>
                <div class="pop-tb-grid pop-tb-grid-tools" role="group" aria-describedby="pop-tb-tools-desc">
                  <button type="button" class="pop-btn pop-tool pop-tb-grid-btn" data-tool="select" aria-pressed="true">
                    <span class="pop-tb-grid-title">Select</span>
                    <span class="pop-tb-grid-sub">Move and resize</span>
                  </button>
                  <button type="button" class="pop-btn pop-tool pop-tb-grid-btn" data-tool="rect" aria-pressed="false">
                    <span class="pop-tb-grid-title">Rectangle</span>
                    <span class="pop-tb-grid-sub">Filled box</span>
                  </button>
                  <button type="button" class="pop-btn pop-tool pop-tb-grid-btn" data-tool="ellipse" aria-pressed="false">
                    <span class="pop-tb-grid-title">Ellipse</span>
                    <span class="pop-tb-grid-sub">Circle or oval</span>
                  </button>
                  <button type="button" class="pop-btn pop-tool pop-tb-grid-btn" data-tool="text" aria-pressed="false">
                    <span class="pop-tb-grid-title">Text</span>
                    <span class="pop-tb-grid-sub">Place a label</span>
                  </button>
                  <button type="button" class="pop-btn pop-tool pop-tb-grid-btn" data-tool="image" aria-pressed="false">
                    <span class="pop-tb-grid-title">Image</span>
                    <span class="pop-tb-grid-sub">Embed raster</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="pop-tb-dd" data-pop-tb-dd>
              <button type="button" class="pop-btn pop-tb-dd-trigger" id="pop-tb-view-btn" aria-expanded="false" aria-haspopup="true" aria-controls="pop-tb-view-panel">View</button>
              <div class="pop-tb-dd-panel" id="pop-tb-view-panel" role="region" aria-labelledby="pop-tb-view-btn" hidden>
                <p class="pop-tb-dd-desc">Zoom the canvas; reset returns to 100% and centered pan.</p>
                <div class="pop-tb-grid pop-tb-grid-view" role="group" aria-label="Canvas zoom">
                  <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-out" aria-label="Zoom out">−</button>
                  <span class="pop-zoom-pct pop-tb-zoom-readout" id="pop-zoom-pct" aria-live="polite">100%</span>
                  <button type="button" class="pop-btn pop-zoom-btn" id="pop-zoom-in" aria-label="Zoom in">+</button>
                  <button type="button" class="pop-btn pop-tb-span2" id="pop-zoom-reset" title="Reset zoom and pan to 100%">Reset view</button>
                </div>
              </div>
            </div>
            <div class="pop-tb-dd" data-pop-tb-dd>
              <button type="button" class="pop-btn pop-tb-dd-trigger" id="pop-tb-style-btn" aria-expanded="false" aria-haspopup="true" aria-controls="pop-tb-style-panel">Style</button>
              <div class="pop-tb-dd-panel pop-tb-style-panel" id="pop-tb-style-panel" role="region" aria-labelledby="pop-tb-style-btn" hidden>
                <p class="pop-tb-dd-desc">Defaults for new shapes; also updates selected rectangles, ellipses, and text.</p>
                <div class="pop-tb-style-grid">
                  <div class="pop-tb-style-block">
                    <span class="pop-tb-style-lbl">Fill</span>
                    <div class="pop-color-picker">
                      <button type="button" class="pop-color-swatch" id="pop-fill-swatch" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop-fill-panel" title="Fill color"></button>
                      <input type="color" class="pop-color-native" id="pop-fill" value="#3b82f6" tabindex="-1" />
                      <div class="pop-color-panel" id="pop-fill-panel" role="dialog" aria-label="Fill color palette" hidden>
                        <div class="pop-color-panel-cap">Theme colors</div>
                        <div class="pop-color-grid pop-color-grid-theme" id="pop-fill-theme"></div>
                        <div class="pop-color-panel-cap">Standard colors</div>
                        <div class="pop-color-grid pop-color-grid-standard" id="pop-fill-standard"></div>
                        <button type="button" class="pop-btn pop-color-more" id="pop-fill-more">More colors…</button>
                      </div>
                    </div>
                  </div>
                  <div class="pop-tb-style-block">
                    <span class="pop-tb-style-lbl">Stroke</span>
                    <div class="pop-color-picker">
                      <button type="button" class="pop-color-swatch" id="pop-stroke-swatch" aria-haspopup="dialog" aria-expanded="false" aria-controls="pop-stroke-panel" title="Stroke color"></button>
                      <input type="color" class="pop-color-native" id="pop-stroke" value="#1e3a5f" tabindex="-1" />
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
                    <span class="pop-tb-style-lbl">Stroke width</span>
                    <input type="range" id="pop-stroke-w" min="0" max="12" value="2" aria-label="Stroke width" />
                  </label>
                </div>
              </div>
            </div>
            <div class="pop-tb-dd" data-pop-tb-dd>
              <button type="button" class="pop-btn pop-tb-dd-trigger" id="pop-tb-export-btn" aria-expanded="false" aria-haspopup="true" aria-controls="pop-tb-export-panel">Export</button>
              <div class="pop-tb-dd-panel" id="pop-tb-export-panel" role="region" aria-labelledby="pop-tb-export-btn" hidden>
                <p class="pop-tb-dd-desc">Save SVG to your device.</p>
                <div class="pop-tb-grid pop-tb-grid-actions" role="group" aria-label="Export">
                  <button type="button" class="pop-btn pop-primary pop-tb-grid-btn" id="pop-export-sel">
                    <span class="pop-tb-grid-title">Selection</span>
                    <span class="pop-tb-grid-sub">SVG of picked layers</span>
                  </button>
                  <button type="button" class="pop-btn pop-tb-grid-btn" id="pop-export-all">
                    <span class="pop-tb-grid-title">Full canvas</span>
                    <span class="pop-tb-grid-sub">Everything on the artboard</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="pop-tb-dd" data-pop-tb-dd>
              <button type="button" class="pop-btn pop-tb-dd-trigger" id="pop-tb-arrange-btn" aria-expanded="false" aria-haspopup="true" aria-controls="pop-tb-arrange-panel">Selection</button>
              <div class="pop-tb-dd-panel" id="pop-tb-arrange-panel" role="region" aria-labelledby="pop-tb-arrange-btn" hidden>
                <p class="pop-tb-dd-desc">Organize the layers you have selected in the list or on the canvas.</p>
                <div class="pop-tb-grid pop-tb-grid-actions" role="group" aria-label="Selection actions">
                  <button type="button" class="pop-btn pop-tb-grid-btn" id="pop-group" disabled>
                    <span class="pop-tb-grid-title">Group</span>
                    <span class="pop-tb-grid-sub">Merge into one folder</span>
                  </button>
                  <button type="button" class="pop-btn pop-tb-grid-btn" id="pop-ungroup" disabled>
                    <span class="pop-tb-grid-title">Ungroup</span>
                    <span class="pop-tb-grid-sub">Split one group</span>
                  </button>
                  <button type="button" class="pop-btn pop-danger pop-tb-grid-btn pop-tb-span2" id="pop-delete" disabled>
                    <span class="pop-tb-grid-title">Delete</span>
                    <span class="pop-tb-grid-sub">Remove selected layers</span>
                  </button>
                </div>
              </div>
            </div>
            <div class="pop-tb-dd" data-pop-tb-dd>
              <button type="button" class="pop-btn pop-tb-dd-trigger" id="pop-tb-comp-btn" aria-expanded="false" aria-haspopup="true" aria-controls="pop-tb-comp-panel">Components</button>
              <div class="pop-tb-dd-panel pop-tb-comp-panel" id="pop-tb-comp-panel" role="region" aria-labelledby="pop-tb-comp-btn" hidden>
                <p class="pop-tb-dd-desc">Reusable symbols and instances.</p>
                <div class="pop-tb-grid pop-tb-grid-actions" role="group" aria-label="Component actions">
                  <button type="button" class="pop-btn pop-tb-grid-btn" id="pop-create-comp" disabled>
                    <span class="pop-tb-grid-title">Create component</span>
                    <span class="pop-tb-grid-sub">From selection</span>
                  </button>
                  <button type="button" class="pop-btn pop-tb-grid-btn" id="pop-detach" disabled>
                    <span class="pop-tb-grid-title">Detach instance</span>
                    <span class="pop-tb-grid-sub">Edit as raw layers</span>
                  </button>
                  <button type="button" class="pop-btn pop-tb-grid-btn pop-tb-span2" id="pop-edit-comp" disabled>
                    <span class="pop-tb-grid-title">Edit main</span>
                    <span class="pop-tb-grid-sub">Open component definition</span>
                  </button>
                </div>
                <div class="pop-tb-comp-insert">
                  <span class="pop-tb-style-lbl">Insert instance</span>
                  <div class="pop-tb-comp-insert-row">
                    <select id="pop-comp-pick" class="pop-comp-pick" aria-label="Component to insert"></select>
                    <button type="button" class="pop-btn" id="pop-insert-inst">Place</button>
                  </div>
                </div>
              </div>
            </div>
            <input type="file" id="pop-file" accept="image/*" hidden />
          </div>
        </div>
        <p class="pop-toolbar-hint" id="pop-toolbar-hint">Toolbar is hidden. Pin it to use tools, zoom, colors, and export.</p>
      </div>
      <div class="pop-comp-banner" id="pop-comp-banner" hidden>
        <span id="pop-comp-banner-text"></span>
        <button type="button" class="pop-btn pop-primary" id="pop-comp-done">Done editing</button>
      </div>
      <div class="pop-main">
        <aside class="pop-layers" aria-label="Layers and transform">
          <div class="pop-layer-aside-head">
            <div class="pop-layer-tabs" role="tablist" aria-label="Layer panel">
              <button type="button" class="pop-layer-tab pop-layer-tab-active" role="tab" id="pop-tab-layers" aria-selected="true" aria-controls="pop-layers-tree-panel">Layers</button>
              <button type="button" class="pop-layer-tab" role="tab" id="pop-tab-parent" aria-selected="false" aria-controls="pop-layers-parent-panel">Parent</button>
            </div>
            <p class="pop-layer-aside-hint">Drag a row to reorder or nest (lower half nests). ⌘ or Ctrl+click to multi-select.</p>
          </div>
          <div id="pop-layers-tree-panel" class="pop-layer-tab-panel" role="tabpanel" aria-labelledby="pop-tab-layers">
            <ul class="pop-layer-list" id="pop-layers" data-pop-layer-tree></ul>
          </div>
          <div id="pop-layers-parent-panel" class="pop-layer-tab-panel" hidden role="tabpanel" aria-labelledby="pop-tab-parent">
            <p class="pop-parent-panel-desc" id="pop-parent-panel-desc">Select a layer to see its parent chain.</p>
            <ol class="pop-parent-chain" id="pop-parent-chain" aria-label="Parent chain from root to selection"></ol>
            <button type="button" class="pop-btn pop-btn-block" id="pop-select-siblings" disabled>Select all siblings</button>
          </div>
          <div class="pop-props">
            <h2>Transform</h2>
            <div class="pop-prop-grid" id="pop-prop-grid">
              <label class="pop-field"><span class="pop-field-lbl">X</span><input type="number" id="pop-px" class="pop-num" step="1" disabled /></label>
              <label class="pop-field"><span class="pop-field-lbl">Y</span><input type="number" id="pop-py" class="pop-num" step="1" disabled /></label>
              <label class="pop-field" id="pop-pw-wrap"><span class="pop-field-lbl">W</span><input type="number" id="pop-pw" class="pop-num" step="1" min="1" disabled /></label>
              <label class="pop-field" id="pop-ph-wrap"><span class="pop-field-lbl">H</span><input type="number" id="pop-ph" class="pop-num" step="1" min="1" disabled /></label>
            </div>
            <label class="pop-field pop-field-fs" id="pop-fs-wrap"><span class="pop-field-lbl">Font size</span><input type="number" id="pop-pfs" class="pop-num" step="1" min="4" max="400" disabled /></label>
            <div class="pop-symmetry">
              <label class="pop-check"><input type="checkbox" id="pop-guides" checked /><span>Symmetry guides &amp; snap</span></label>
              <p class="pop-hint" id="pop-sym-hint"></p>
            </div>
          </div>
        </aside>
        <div class="pop-canvas-wrap" title="Ctrl or ⌘ + scroll (or trackpad pinch) to zoom toward the pointer">
          <svg class="pop-canvas" id="pop-svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}" role="img" aria-label="Design canvas">
            <defs>
              <pattern id="pop-grid" width="16" height="16" patternUnits="userSpaceOnUse">
                <rect width="16" height="16" fill="var(--canvas-cell)"/>
                <path d="M 16 0 L 0 0 0 16" fill="none" stroke="var(--canvas-line)" stroke-width="0.5"/>
              </pattern>
            </defs>
            <rect class="pop-canvas-bg" x="0" y="0" width="${VIEW_W}" height="${VIEW_H}" fill="url(#pop-grid)" pointer-events="none"/>
            <g id="pop-viewport" transform="translate(0 0) scale(1)">
              <g id="pop-guides-back" pointer-events="none"></g>
              <g id="pop-items"></g>
              <g id="pop-handles"></g>
              <g id="pop-guides-front" pointer-events="none"></g>
            </g>
          </svg>
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
  const btnCreateComp = root.querySelector<HTMLButtonElement>('#pop-create-comp')!
  const btnDetach = root.querySelector<HTMLButtonElement>('#pop-detach')!
  const btnEditComp = root.querySelector<HTMLButtonElement>('#pop-edit-comp')!
  const selCompPick = root.querySelector<HTMLSelectElement>('#pop-comp-pick')!
  const btnInsertInst = root.querySelector<HTMLButtonElement>('#pop-insert-inst')!
  const compBanner = root.querySelector<HTMLElement>('#pop-comp-banner')!
  const compBannerText = root.querySelector<HTMLElement>('#pop-comp-banner-text')!
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
  const btnZoomIn = root.querySelector<HTMLButtonElement>('#pop-zoom-in')!
  const btnZoomOut = root.querySelector<HTMLButtonElement>('#pop-zoom-out')!
  const btnZoomReset = root.querySelector<HTMLButtonElement>('#pop-zoom-reset')!
  const elZoomPct = root.querySelector<HTMLElement>('#pop-zoom-pct')!
  const toolbarWrap = root.querySelector<HTMLElement>('#pop-toolbar-wrap')!
  const btnToolbarPin = root.querySelector<HTMLButtonElement>('#pop-toolbar-pin')!
  const toolbarExpanded = root.querySelector<HTMLElement>('#pop-toolbar-expanded')!
  const toolbarHint = root.querySelector<HTMLElement>('#pop-toolbar-hint')!
  const pinLabelEl = btnToolbarPin.querySelector<HTMLElement>('.pop-toolbar-pin-label')!

  /** Pinned unless user chose to hide (`'0'` in storage). */
  let toolbarPinned = localStorage.getItem(TOOLBAR_PIN_STORAGE_KEY) !== '0'
  let openTbDropdown: { panel: HTMLElement; trigger: HTMLButtonElement } | null = null

  function closeTbDropdown(): void {
    if (!openTbDropdown) return
    openTbDropdown.panel.hidden = true
    openTbDropdown.trigger.setAttribute('aria-expanded', 'false')
    openTbDropdown = null
  }

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

  function panelRectIntersectsBanner(
    left: number,
    top: number,
    pw: number,
    ph: number,
  ): boolean {
    if (compBanner.hidden) return false
    const br = compBanner.getBoundingClientRect()
    if (br.width === 0 || br.height === 0) return false
    const prRight = left + pw
    const prBottom = top + ph
    return !(prRight <= br.left || left >= br.right || prBottom <= br.top || top >= br.bottom)
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

    if (panelRectIntersectsBanner(left, top, pw, ph)) {
      const above = r.top - ph - margin
      if (above >= margin && !panelRectIntersectsBanner(left, above, pw, ph)) {
        top = above
      } else {
        const br = compBanner.getBoundingClientRect()
        const belowBanner = br.bottom + margin
        if (belowBanner + ph <= window.innerHeight - margin) {
          top = belowBanner
        } else if (above >= margin) {
          top = above
        }
      }
    }

    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }

  function positionTbDropdown(panel: HTMLElement, trigger: HTMLElement): void {
    panel.style.position = 'fixed'
    panel.style.zIndex = '1999'
    const r = trigger.getBoundingClientRect()
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

    if (panelRectIntersectsBanner(left, top, pw, ph)) {
      const above = r.top - ph - margin
      if (above >= margin && !panelRectIntersectsBanner(left, above, pw, ph)) {
        top = above
      } else {
        const br = compBanner.getBoundingClientRect()
        const belowBanner = br.bottom + margin
        if (belowBanner + ph <= window.innerHeight - margin) {
          top = belowBanner
        } else if (above >= margin) {
          top = above
        }
      }
    }

    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
  }

  function openTbDropdownPanel(panel: HTMLElement, trigger: HTMLButtonElement): void {
    closeColorPickerPanel()
    closeTbDropdown()
    panel.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    openTbDropdown = { panel, trigger }
    requestAnimationFrame(() => {
      positionTbDropdown(panel, trigger)
      requestAnimationFrame(() => positionTbDropdown(panel, trigger))
    })
  }

  function toggleTbDropdownPanel(panel: HTMLElement, trigger: HTMLButtonElement): void {
    if (openTbDropdown?.panel === panel) {
      closeTbDropdown()
      return
    }
    openTbDropdownPanel(panel, trigger)
  }

  function toggleColorPickerPanel(panel: HTMLElement, swatch: HTMLButtonElement): void {
    if (openColorPicker?.panel === panel) {
      closeColorPickerPanel()
      return
    }
    closeTbDropdown()
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
      if (openTbDropdown) {
        if (!openTbDropdown.panel.contains(t) && !openTbDropdown.trigger.contains(t)) {
          closeTbDropdown()
        }
      }
      if (!openColorPicker) return
      if (openColorPicker.panel.contains(t) || openColorPicker.swatch.contains(t)) return
      closeColorPickerPanel()
    },
    true,
  )

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeTbDropdown()
      closeColorPickerPanel()
    }
  })

  window.addEventListener('resize', () => {
    closeTbDropdown()
    closeColorPickerPanel()
  })
  window.addEventListener(
    'scroll',
    () => {
      closeTbDropdown()
      closeColorPickerPanel()
    },
    true,
  )

  function applyToolbarPinState(): void {
    toolbarExpanded.hidden = !toolbarPinned
    toolbarHint.hidden = toolbarPinned
    btnToolbarPin.setAttribute('aria-pressed', String(toolbarPinned))
    btnToolbarPin.setAttribute('aria-expanded', String(toolbarPinned))
    toolbarWrap.classList.toggle('pop-toolbar-pinned', toolbarPinned)
    pinLabelEl.textContent = toolbarPinned ? 'Unpin toolbar' : 'Pin toolbar'
    if (!toolbarPinned) {
      closeTbDropdown()
      closeColorPickerPanel()
    }
  }

  btnToolbarPin.addEventListener('click', () => {
    toolbarPinned = !toolbarPinned
    localStorage.setItem(TOOLBAR_PIN_STORAGE_KEY, toolbarPinned ? '1' : '0')
    applyToolbarPinState()
  })

  root.querySelectorAll<HTMLElement>('[data-pop-tb-dd]').forEach((wrap) => {
    const trigger = wrap.querySelector<HTMLButtonElement>('.pop-tb-dd-trigger')
    const panel = wrap.querySelector<HTMLElement>('.pop-tb-dd-panel')
    if (!trigger || !panel) return
    trigger.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (!toolbarPinned) return
      toggleTbDropdownPanel(panel, trigger)
    })
  })

  toolbarExpanded.addEventListener(
    'click',
    (e) => {
      if (!openTbDropdown) return
      const hit = e.target as HTMLElement
      if (hit.closest('.pop-tb-dd-trigger')) return
      if (hit.closest('.pop-color-panel')) return
      if (hit.closest('.pop-color-swatch')) return
      if (hit.closest('input[type="range"]')) return
      if (hit.closest('select')) return
      if (!openTbDropdown.panel.contains(hit)) return
      if (hit.closest('button')) {
        queueMicrotask(() => closeTbDropdown())
      }
    },
    true,
  )

  applyToolbarPinState()

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function syncViewportTransform(): void {
    viewportG.setAttribute('transform', `translate(${viewTx} ${viewTy}) scale(${viewScale})`)
  }

  function updateZoomPctLabel(): void {
    elZoomPct.textContent = `${Math.round(viewScale * 100)}%`
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

  function persistToStorage(): void {
    try {
      const payload: PersistedStateV2 = {
        v: 2,
        rootIds: [...rootIds],
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
      localStorage.setItem(STORAGE_KEY_V2, JSON.stringify(payload))
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

  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY_V2)
    if (rawV2) {
      const data = JSON.parse(rawV2) as Partial<PersistedStateV2>
      if (data.v === 2 && data.nodes && typeof data.nodes === 'object' && Array.isArray(data.rootIds)) {
        nodes = recordToNodes(data.nodes as Record<string, SceneNode>)
        rootIds = data.rootIds.filter((id) => nodes.has(id))
        if (data.definitions && typeof data.definitions === 'object') {
          definitions = recordToDefs(data.definitions as Record<string, ComponentDefinition>)
        }
        if (data.layerNames && typeof data.layerNames === 'object') {
          layerNames = { ...data.layerNames }
        }
        editingComponentId = null
        const keepIds = new Set(nodes.keys())
        for (const k of Object.keys(layerNames)) {
          if (!keepIds.has(k)) delete layerNames[k]
        }
        applyLoadedView(data)
      }
    } else {
      const rawV1 = localStorage.getItem(STORAGE_KEY_V1)
      if (rawV1) {
        const data = JSON.parse(rawV1) as Partial<PersistedStateV1>
        if (data.v === 1 && Array.isArray(data.items)) {
          const next = data.items.filter(isValidCanvasItem)
          const mig = migrateV1ToScene(next)
          rootIds = mig.rootIds
          nodes = mig.nodes
          if (data.layerNames && typeof data.layerNames === 'object') {
            layerNames = { ...data.layerNames }
          }
          const ids = new Set(nodes.keys())
          for (const k of Object.keys(layerNames)) {
            if (!ids.has(k)) delete layerNames[k]
          }
          applyLoadedView(data)
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
      l.setAttribute('stroke', '#7c9cff')
      l.setAttribute('stroke-opacity', '0.35')
      l.setAttribute('stroke-width', '1')
      l.setAttribute('stroke-dasharray', '8 6')
      l.setAttribute('vector-effect', 'non-scaling-stroke')
      return l
    }
    guidesBack.appendChild(mkLine(VIEW_W / 2, 0, VIEW_W / 2, VIEW_H))
    guidesBack.appendChild(mkLine(0, VIEW_H / 2, VIEW_W, VIEW_H / 2))
  }

  function renderSnapGuides(verticalX: number | null, horizontalY: number | null): void {
    guidesFront.replaceChildren()
    if (verticalX !== null) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      l.setAttribute('x1', String(verticalX))
      l.setAttribute('x2', String(verticalX))
      l.setAttribute('y1', '0')
      l.setAttribute('y2', String(VIEW_H))
      l.setAttribute('stroke', '#c4d0ff')
      l.setAttribute('stroke-width', '1.5')
      l.setAttribute('vector-effect', 'non-scaling-stroke')
      guidesFront.appendChild(l)
    }
    if (horizontalY !== null) {
      const l = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      l.setAttribute('x1', '0')
      l.setAttribute('x2', String(VIEW_W))
      l.setAttribute('y1', String(horizontalY))
      l.setAttribute('y2', String(horizontalY))
      l.setAttribute('stroke', '#c4d0ff')
      l.setAttribute('stroke-width', '1.5')
      l.setAttribute('vector-effect', 'non-scaling-stroke')
      guidesFront.appendChild(l)
    }
  }

  for (const el of [inpX, inpY, inpW, inpH, inpFs]) {
    el.addEventListener('focus', () => {
      propsPanelFocused = true
    })
    el.addEventListener('blur', () => {
      propsPanelFocused = false
      syncPropsFromSelection()
    })
    el.addEventListener('input', () => applyTransformFromInputs())
  }

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
    closeTbDropdown()
    renderHandles()
  }

  function getNode(id: string): SceneNode | undefined {
    return nodes.get(id)
  }

  function removeChildRef(parentId: string | null, childId: string): void {
    if (parentId === null) {
      rootIds = rootIds.filter((id) => id !== childId)
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
      const i = clamp(index, 0, rootIds.length)
      rootIds.splice(i, 0, childId)
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
      rootIds.splice(insertIdx, 1)
      rootIds.splice(insertIdx, 0, ...kids)
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
    insertChildRef(parentId, instId, insertIdx >= 0 ? insertIdx : rootIds.length)
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
    insertChildRef(parentId, newRoot, insertIdx >= 0 ? insertIdx : rootIds.length)
    selected = new Set([newRoot])
    commit()
  }

  function insertComponentInstance(compId: string): void {
    const def = definitions.get(compId)
    if (!def) return
    const w = Math.min(def.intrinsicW, VIEW_W * 0.5)
    const h = Math.min(def.intrinsicH, VIEW_H * 0.5)
    const nid = newId()
    nodes.set(nid, {
      id: nid,
      parentId: null,
      type: 'instance',
      componentId: compId,
      x: (VIEW_W - w) / 2,
      y: (VIEW_H - h) / 2,
      width: w,
      height: h,
    })
    rootIds.push(nid)
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
    for (let ri = rootIds.length - 1; ri >= 0; ri--) {
      const h = hitNode(wx, wy, rootIds[ri]!, nodes)
      if (h) return h
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

  function updateComponentBanner(): void {
    if (editingComponentId) {
      const d = definitions.get(editingComponentId)
      compBanner.hidden = false
      compBannerText.textContent = d
        ? `Editing main component: ${d.name}`
        : 'Editing component'
    } else {
      compBanner.hidden = true
    }
  }

  function enterComponentEdit(compId: string): void {
    const d = definitions.get(compId)
    if (!d) return
    closeTbDropdown()
    closeColorPickerPanel()
    mainNodesBackup = new Map(nodes)
    mainRootIdsBackup = [...rootIds]
    nodes = recordToNodes({ ...d.nodes } as Record<string, SceneNode>)
    rootIds = [d.rootId]
    editingComponentId = compId
    selected.clear()
    updateComponentBanner()
    commit()
  }

  function exitComponentEdit(save: boolean): void {
    if (!editingComponentId || !mainNodesBackup || !mainRootIdsBackup) {
      editingComponentId = null
      mainNodesBackup = null
      mainRootIdsBackup = null
      updateComponentBanner()
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
    rootIds = mainRootIdsBackup
    mainNodesBackup = null
    mainRootIdsBackup = null
    editingComponentId = null
    updateComponentBanner()
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
    if (parentId === null) return rootIds
    const p = nodes.get(parentId)
    return p?.type === 'group' ? p.childIds : []
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
    for (const rid of rootIds) {
      renderSceneNode(rid, itemsG)
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
      hr.setAttribute('fill', '#1a1e28')
      hr.setAttribute('stroke', '#7c9cff')
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

  function commit(): void {
    pruneLayerNames()
    renderItems()
    renderHandles()
    renderLayers()
    renderStaticGuides()
    if (!propsPanelFocused) syncPropsFromSelection()
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

  btnZoomIn.addEventListener('click', () => {
    zoomAtWorldPoint(VIEW_W / 2, VIEW_H / 2, viewScale * 1.2)
  })
  btnZoomOut.addEventListener('click', () => {
    zoomAtWorldPoint(VIEW_W / 2, VIEW_H / 2, viewScale / 1.2)
  })
  btnZoomReset.addEventListener('click', () => {
    viewTx = 0
    viewTy = 0
    viewScale = 1
    syncViewportTransform()
    updateZoomPctLabel()
    schedulePersist()
  })

  canvasWrap.addEventListener(
    'wheel',
    (ev) => {
      if (!ev.ctrlKey && !ev.metaKey) return
      if (!canvasWrap.contains(ev.target as Node)) return
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
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW_W}" height="${VIEW_H}" viewBox="0 0 ${VIEW_W} ${VIEW_H}">
${parts}
</svg>
`
    downloadSvg(svg, 'pop-selection.svg')
  })

  btnExportAll.addEventListener('click', () => {
    downloadSvg(serializeSvgFromRoots(rootIds, nodes, definitions, VIEW_W, VIEW_H), 'pop-canvas.svg')
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
        const x = (VIEW_W - w) / 2
        const y = (VIEW_H - h) / 2
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
        })
        rootIds.push(nid)
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
      })
      rootIds.push(nid)
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
      })
      rootIds.push(nid)
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
      })
      rootIds.push(nid)
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
      renderItems()
      renderHandles()
      if (!propsPanelFocused) syncPropsFromSelection()
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
        const tx = collectSnapTargetsX(selected, nodes, definitions)
        const ty = collectSnapTargetsY(selected, nodes, definitions)
        const sx = snapAxis('x', u.left, u.cx, u.right, tx, SNAP_PX)
        const sy = snapAxis('y', u.top, u.cy, u.bottom, ty, SNAP_PX)
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
      schedulePersist()
    }
  })

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && editingComponentId) {
      exitComponentEdit(false)
      return
    }
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      const t = ev.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (selected.size === 0) return
      ev.preventDefault()
      deleteNodesSubtrees(selectedDeletionRoots())
      selected.clear()
      commit()
    }
  })

  setBaseSymHint()
  commit()
}
