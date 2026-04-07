/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POP_AI_URL?: string
  readonly VITE_POP_AI_KEY?: string
  readonly VITE_POP_AI_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
