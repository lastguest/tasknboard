import type { App } from "@modelcontextprotocol/ext-apps";

let bridge: App | undefined;
let selection: { boardId?: string; taskId?: string } = {};
export const embeddedSelection = () => selection;
export const embeddedApp = () => bridge;
export const isEmbedded = () => Boolean(bridge);
export const workspaceChanged = new EventTarget();

export async function connectEmbedded() {
  const { App } = await import("@modelcontextprotocol/ext-apps");
  bridge = new App({ name: "TasknBoard", version: __APP_VERSION__ }, {}, { autoResize: false });
  bridge.ontoolinput = ({ arguments: args = {} }) => {
    selection = {
      ...(typeof args.boardId === "string" ? { boardId: args.boardId } : {}),
      ...(typeof args.taskId === "string" ? { taskId: args.taskId } : {}),
    };
    if (selection.taskId) location.hash = `task/${encodeURIComponent(selection.taskId)}`;
    workspaceChanged.dispatchEvent(new Event("selection"));
  };
  bridge.ontoolresult = () => workspaceChanged.dispatchEvent(new Event("change"));
  await bridge.connect();
  document.addEventListener("click", (event) => {
    const link = (event.target as Element).closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement) || link.getAttribute("href")?.startsWith("#")) return;
    event.preventDefault();
    if (/^https?:$/.test(new URL(link.href).protocol)) {
      void (bridge!.getHostCapabilities()?.openLinks
        ? bridge!.openLink({ url: link.href }).then(result => { if (result.isError) throw new Error("Link rejected"); })
        : Promise.reject(new Error("External links unavailable"))).catch(() => {
        workspaceChanged.dispatchEvent(new CustomEvent("hosterror", { detail: "The host could not open the link." }));
      });
    }
  }, true);
}
