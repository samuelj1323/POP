# POP — agent and LLM context

This repository is **Pop**, a browser-based **vibe designing** platform (Svelte 5 + Vite + TypeScript). The product name in the UI is **POP**. Users maintain a **component library** (named HTML fragments, typically with inline CSS or `<style>`) and an ordered **page** of **placements** that reference library ids. The **iframe preview renders only placements**, not the whole library. State persists in `localStorage`.

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
| `src/App.svelte` | **Main shell**: Library vs Page builder modes, iframe preview, Design assistant |
| `src/style.css` | Global tokens, reset, `#app` layout |

**Rule of thumb:** Product UI lives in **`App.svelte`**. Shared types, persistence, preview HTML, LLM helpers, and patch application live under **`src/studio/`**.

## Domain model (`src/studio/`)

| Module | Contents |
|--------|----------|
| `vibe-document.ts` | `VibeComponent`, `VibePagePlacement`, `VibeDocument` (**v: 2**), `normalizeVibeDocument()`, `documentToVibeContextJson()` |
| `vibe-persistence.ts` | `VIBE_STORAGE_KEY`, `loadVibeDocument`, `saveVibeDocument` (loads v1 JSON and upgrades to v2 with empty `pagePlacements`) |
| `vibe-preview-html.ts` | `buildVibePreviewSrcdoc(pagePlacements, components)` — iframe `srcdoc` from **page only** |
| `vibe-patch.ts` | `VibePatchOp` (library + page ops), `applyVibePatchOps()` — `removeComponent` also drops placements for that `componentId` |
| `llm-design.ts` | Gemini/OpenAI-compatible fetch, `buildVibeDesignLlmSystemPrompt()`, `parseVibePatchOpsFromLlmText()`, AI settings in `localStorage` |
| `id.ts` | `newId()` (UUID) |

**Document shape (`v: 2`):** `components[]` = library definitions; `pagePlacements[]` = `{ id, componentId, inputValues, layout }` in top-to-bottom preview order. Each placement `layout` controls iframe slot chrome (width, spacing, surface); see `src/studio/vibe-placement-layout.ts`.

Legacy **SVG studio** modules have been removed.

## UI modes (`App.svelte`)

- **Library** — create/edit/delete definitions; does not change the page stack.
- **Page builder** — add placements from the library, reorder (up/down), remove from page.

## Design assistant (LLM ↔ vibe document)

The **Design assistant** connects an LLM to the live document:

1. **Send context**: JSON from `documentToVibeContextJson(doc)` (library + `pagePlacements`) plus the user request.
2. **Model output**: JSON only — array of patch ops or `{"ops":[...]}` (see `buildVibeDesignLlmSystemPrompt()`).
3. **Apply**: `parseVibePatchOpsFromLlmText` → `applyVibePatchOps` → updates `doc`; persistence runs via `$effect` after hydration.

**API**: Gemini uses `buildGeminiGenerateContentUrl(modelId)` and header **`X-goog-api-key`**. **Configuration**: `localStorage` keys `pop-ai-key`, `pop-ai-model`, optional `pop-ai-endpoint`, or Vite **`VITE_POP_AI_KEY`**, **`VITE_POP_AI_MODEL`** (see `.env.example`). Direct browser calls may be blocked by **CORS**; use a same-origin proxy if needed.

## Conventions for changes

- **Svelte 5**: runes (`$state`, `$effect`, etc.) in `.svelte` files.
- **Imports**: use `.ts` extensions in import paths where the codebase already does (e.g. `'./studio/vibe-document.ts'`).
- **Persistence**: avoid saving before `onMount` hydration — see `docHydrated` in `App.svelte`.

## LLM prompt template (copy-paste)

```text
You are working in the POP repo: a Svelte 5 + Vite + TypeScript vibe designing platform.

Constraints:
- Read AGENTS.md at the repo root for architecture.
- Prefer editing src/studio/ for types and pure logic; App.svelte for UI.
- After changing types, run: npm run check

Task:
<describe the feature: user-visible behavior, edge cases, and any new types>

Deliver:
- List of files changed
- Brief summary of behavior
```

## What not to assume

- There is no separate `components/` UI library folder yet; chrome is in `App.svelte`.
