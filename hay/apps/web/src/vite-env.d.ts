/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WS_URL?: string;
  readonly VITE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
