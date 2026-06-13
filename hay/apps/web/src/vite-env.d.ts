/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Build-time stamp (git short hash · date) injected via vite define.
declare const __BUILD_STAMP__: string;
