# POP — agent and LLM context

This repository is **Pop**, a browser-based **vibe designing** platform for **web and mobile** layouts (Svelte 5 + Vite + TypeScript). The product name in the UI is **POP**. Users sketch screens and graphics on an SVG canvas with frames; export **SVG** or **HTML**.

## Quick commands

| Command | Purpose |
|--------|---------|
| `npm install` | Install dependencies |
| `npm run dev` | Dev server (Vite) |
| `npm run build` | Production build |
| `npm run check` | `svelte-check` + TypeScript |

## Entry and layout

| File | Role |
|------|------|
| `index.html` | Mounts `#app`, loads `src/main.ts` |
| `src/main.ts` | `mount(App, { target })` — Svelte entry |
| `src/App.svelte` | Thin shell: `onMount` → `mount(host)` from `svg-studio.ts` |
| `src/svg-studio.ts` | **Main editor**: imperative DOM (large file), `export function mount(root: HTMLElement)` |
| `src/style.css` | Global styles |

**Rule of thumb:** New UI that belongs in the chrome/canvas/toolbar usually lives in **`svg-studio.ts`** (or is extracted from it). New pure logic, types, and serialization live under **`src/studio/`**.

## Domain model (`src/studio/`)

| Module | Contents |
|--------|----------|
| `scene-types.ts` | `Tool`, `SceneNode` (rect, ellipse, text, image, group, instance), `ComponentDefinition`, `GroupLayout`, `HtmlExportRole` |
| `document.ts` | `PopDocumentV3`, `PopFrame`, `DesignTokens`, world bounds, migration helpers |
| `persistence.ts` | localStorage keys `STORAGE_KEY_V1` … `V3`, load/save, `normalizeSceneNode` |
| `patch.ts` | `PatchOp`, `applyPatch` — apply structured edits to `PopDocumentV3` (used by the Design assistant) |
| `llm-design.ts` | `fetchDesignLlmReply`, `buildGeminiGenerateContentUrl`, `GOOGLE_AI_STUDIO_GEMINI_MODELS`, `buildDesignLlmSystemPrompt`, `parsePatchOpsFromLlmText`, AI settings in `localStorage` |
| `svg-export.ts` | SVG fragment generation, download |
| `html-export.ts` | HTML export from frames |
| `layout-geometry.ts` | Bounds, resize handles, hierarchy |
| `snap.ts` | Snapping |
| `constants.ts` | e.g. `VIEW_W`/`VIEW_H` (default frame 960×540), grid, scale limits |
| `id.ts` | `newId()` for nodes |
| `math.ts` | `clamp` and small math helpers |
| `color-palette.ts` | Palette / theme helpers |

Current document version is **`PopDocumentV3`** (`v: 3`); persistence uses **`STORAGE_KEY_V3`**.

## Design assistant (LLM ↔ canvas)

The in-app **Design assistant** (right column in `svg-studio.ts`, `pop-ai-*` elements) connects an LLM to the live document for **vibe designing** web and mobile UI (natural language → structured canvas edits):

1. **Send context**: The user message includes a short POP product framing plus the current document from `documentToV3Json(buildDocumentV3())` and the user’s natural-language request.
2. **Model output**: The model must return **only JSON**: a JSON array of patch operations, or `{"ops":[...]}`. The system prompt is `buildDesignLlmSystemPrompt()` in `llm-design.ts` (allowed ops match `patch.ts`); it describes POP as a web/mobile vibe designing tool and asks the model to interpret UI-oriented requests accordingly.
3. **Apply**: `parsePatchOpsFromLlmText` → `applyPatch` → `applyDocumentV3` in `svg-studio.ts`, then the canvas re-renders and state persists as usual.

**API**: The UI uses **Google Gemini** only: the endpoint URL is built with `buildGeminiGenerateContentUrl(modelId)`; the API key is sent as **`X-goog-api-key`**. `fetchDesignLlmReply` still supports an OpenAI-style URL if passed programmatically. **Configuration**: `localStorage` keys `pop-ai-key`, `pop-ai-model` (selected Gemini id), or Vite defaults **`VITE_POP_AI_KEY`**, **`VITE_POP_AI_MODEL`** (see `.env.example`). Direct browser calls may be blocked by **CORS**; use a same-origin proxy if needed.

## Conventions for changes

- **Svelte 5**: runes (`$state`, etc.) in `.svelte` files; the studio itself is mostly vanilla TS + DOM in `svg-studio.ts`.
- **Imports**: use `.ts` extensions in import paths where the codebase already does (e.g. `'./studio/constants.ts'`).
- **Types**: extend `SceneNode` / `Tool` in `scene-types.ts` when adding node kinds or tools; thread through `persistence.ts` normalization and any switch statements in `svg-studio.ts` and exporters.
- **Before adding parallel UI patterns**: search `svg-studio.ts` for existing buttons, panels, and class names (`pop-*`) and match them.

## LLM prompt template (copy-paste)

Use this when asking an LLM to implement a feature in this repo:

```text
You are working in the POP repo: a Svelte 5 + Vite + TypeScript SVG editor positioned as a vibe designing platform for web and mobile (browser canvas, SVG/HTML export).

Constraints:
- Read AGENTS.md at the repo root for architecture.
- Prefer editing src/studio/ for types and pure logic; svg-studio.ts for UI and canvas behavior (file is large—search before editing).
- After changing types, run: npm run check
- Match existing CSS class prefix pop-* and existing patterns in svg-studio.ts.
- When changing product-facing copy, SEO (`index.html`), or the Design assistant, keep messaging aligned with vibe designing for web and mobile.

Task:
<describe the feature: user-visible behavior, edge cases, and any new types or tools>

Deliver:
- List of files changed
- Brief summary of behavior
```

## Optional: “greenfield” generation prompt

If generating a new screen or module from scratch:

```text
Stack: Svelte 5 (runes), Vite, TypeScript. Entry: src/main.ts → App.svelte.
POP is a vibe designing tool for web and mobile UI on an SVG canvas with frames; export SVG or HTML.
Studio editor is mounted via svg-studio.ts mount(). For new features, either extend src/studio/ types and wire in svg-studio.ts, or add a new .svelte component and import it from App.svelte if the feature is separate from the canvas.
Follow existing patterns in src/style.css and pop-* class names.
```

## What not to assume

- There is no separate `components/` UI library folder yet; the editor UI is concentrated in `svg-studio.ts`.
- Raster images in SVG export are embedded as `<image>`; they are not auto-traced.
