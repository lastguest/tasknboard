/// <reference types="vite/client" />

/** Present only inside the TasknBoard iOS app. */
interface Window {
  tasknboardShell?: { changeServer(): void };
}
