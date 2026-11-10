/// <reference types="vite/client" />

interface Window {
  tasknboardDesktop?: boolean;
  /** Present only inside the TasknBoard iOS app. */
  tasknboardShell?: { changeServer(): void };
}

declare const __APP_VERSION__: string;
