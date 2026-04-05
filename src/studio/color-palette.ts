import { clamp } from './math.ts'

/** Normalize to #rrggbb for `<input type="color">` and SVG. */
export function normalizeHex6(hex: string): string {
  let h = hex.trim()
  if (!h.startsWith('#')) h = `#${h}`
  h = h.slice(1)
  if (h.length === 3) {
    h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  }
  if (h.length !== 6) return '#000000'
  const n = parseInt(h, 16)
  if (!Number.isFinite(n)) return '#000000'
  return `#${n.toString(16).padStart(6, '0')}`
}

function parseRgbHex(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex6(hex).slice(1)
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

function mixRgb(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  }
}

/** Grayscale column + tinted columns, similar to Excel’s “Theme colors” grid. */
export function buildExcelThemeGrid(): string[][] {
  const grayCol = ['#ffffff', '#f2f2f2', '#d9d9d9', '#bfbfbf', '#a6a6a6', '#7f7f7f']
  const accentBases = [
    '#c00000',
    '#ff6600',
    '#ffc000',
    '#92d050',
    '#00b050',
    '#00b0f0',
    '#0070c0',
    '#002060',
    '#7030a0',
  ]
  const rows = grayCol.length
  const grid: string[][] = []
  for (let r = 0; r < rows; r++) {
    const t = rows === 1 ? 0 : r / (rows - 1)
    const row: string[] = []
    for (let c = 0; c < 10; c++) {
      if (c === 0) {
        row.push(grayCol[r]!)
      } else {
        const base = parseRgbHex(accentBases[c - 1]!)
        const white = { r: 255, g: 255, b: 255 }
        const tinted = mixRgb(white, base, 0.18 + (1 - t) * 0.72)
        const shaded = mixRgb(tinted, { r: 18, g: 18, b: 18 }, t * 0.52)
        row.push(rgbToHex(shaded.r, shaded.g, shaded.b))
      }
    }
    grid.push(row)
  }
  return grid
}

/** Excel-style “Standard colors” row (common fills). */
export const EXCEL_STANDARD_COLORS = [
  '#000000',
  '#ffffff',
  '#c00000',
  '#ff0000',
  '#ffc000',
  '#ffff00',
  '#92d050',
  '#00b050',
  '#00b0f0',
  '#0070c0',
]
